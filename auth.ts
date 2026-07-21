import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { Elysia } from "elysia";
import { OAuth2Client } from "google-auth-library";
import open from "open";

const CLIENT_SECRET_FILE = "./client_secret.json";
const TOKEN_FILE = "./google_token.json";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

type GoogleClientSecret = {
  installed?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
};

type InstalledClientSecret = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
};

async function loadClientSecret(): Promise<InstalledClientSecret> {
  const file = Bun.file(CLIENT_SECRET_FILE);
  if (!(await file.exists())) {
    throw new Error(
      `缺少 ${CLIENT_SECRET_FILE}，无法使用 Gmail OAuth。请从 Google Cloud Console 下载 OAuth 客户端 JSON，并保存为 ${CLIENT_SECRET_FILE}`,
    );
  }

  const secret = (await file.json()) as GoogleClientSecret;
  const installed = secret.installed;
  if (
    !installed?.client_id ||
    !installed?.client_secret ||
    !installed?.redirect_uris?.[0]
  ) {
    throw new Error(
      `${CLIENT_SECRET_FILE} 格式不完整，需要包含 installed.client_id、installed.client_secret 和 installed.redirect_uris[0]`,
    );
  }

  return {
    client_id: installed.client_id,
    client_secret: installed.client_secret,
    redirect_uri: installed.redirect_uris[0],
  };
}

function normalizeEmailAddress(email?: string) {
  return String(email || "").trim().toLowerCase();
}

function getTokenFile(accountEmail?: string) {
  const normalizedEmail = normalizeEmailAddress(accountEmail);
  if (!normalizedEmail) {
    return TOKEN_FILE;
  }

  return `./google_token.${encodeURIComponent(normalizedEmail)}.json`;
}

function getTokenFileCandidates(accountEmail?: string) {
  const files = [getTokenFile(accountEmail)];
  if (accountEmail) {
    files.push(TOKEN_FILE);
  }

  return [...new Set(files)];
}

async function saveRefreshToken(refreshToken: string, accountEmail?: string) {
  const tokenFile = getTokenFile(accountEmail);
  const tmpDir = "./tmp";
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = `${tmpDir}/token.${crypto.randomUUID()}.tmp`;
  await writeFile(
    tmpFile,
    JSON.stringify({ refresh_token: refreshToken }, null, 2),
    { mode: 0o600 },
  );
  await chmod(tmpFile, 0o600);
  await rename(tmpFile, tokenFile);
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createOAuthClient(secret: InstalledClientSecret) {
  return new OAuth2Client({
    client_id: secret.client_id,
    client_secret: secret.client_secret,
    redirectUri: secret.redirect_uri,
  });
}

async function getGmailProfileEmail(accessToken: string) {
  const response = await fetch(GMAIL_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`读取 Gmail 授权账号失败 HTTP ${response.status}: ${text}`);
  }

  const profile = JSON.parse(text) as { emailAddress?: string };
  if (!profile.emailAddress) {
    throw new Error("Gmail profile 未返回 emailAddress");
  }

  return profile.emailAddress;
}

async function assertTokenMatchesAccount(accessToken: string, accountEmail?: string) {
  const expectedEmail = normalizeEmailAddress(accountEmail);
  if (!expectedEmail) {
    return;
  }

  const actualEmail = normalizeEmailAddress(await getGmailProfileEmail(accessToken));
  if (actualEmail !== expectedEmail) {
    throw new Error(
      `Gmail 授权账号不匹配：当前配置是 ${expectedEmail}，但授权账号是 ${actualEmail}`,
    );
  }
}

export async function getAccessToken(accountEmail?: string): Promise<string> {
  const secret = await loadClientSecret();
  const client = createOAuthClient(secret);

  for (const tokenFile of getTokenFileCandidates(accountEmail)) {
    if (!(await Bun.file(tokenFile).exists())) {
      continue;
    }

    await chmod(tokenFile, 0o600).catch(() => undefined);
    const { refresh_token } = await Bun.file(tokenFile).json();
    if (refresh_token) {
      client.setCredentials({ refresh_token });

      try {
        const { token } = await client.getAccessToken();
        if (!token) {
          throw new Error("No access token returned by Google");
        }
        await assertTokenMatchesAccount(token, accountEmail);
        if (accountEmail && tokenFile !== getTokenFile(accountEmail)) {
          await saveRefreshToken(refresh_token, accountEmail);
        }
        return token;
      } catch (error) {
        process.stderr.write(
          `刷新 Gmail token 失败，将重新打开浏览器授权：${formatErrorMessage(error)}\n`,
        );
      }
    }
  }

  return new Promise((resolve, reject) => {
    const app = new Elysia();
    const state = crypto.randomUUID();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      void app.stop().catch(() => undefined);
      callback();
    };

    app.get("/oauth2callback", async ({ query, set }) => {
      if (query.state !== state) {
        set.status = 400;
        return "授权状态不匹配";
      }

      const error = query.error;
      if (error) {
        const description = query.error_description;
        const message = String(description || error);
        finish(() => reject(new Error(message)));
        set.status = 400;
        return `授权失败：${message}`;
      }

      const code = query.code;
      if (!code) {
        finish(() => reject(new Error("No authorization code")));
        set.status = 400;
        return "缺少授权码";
      }

      try {
        const { tokens } = await client.getToken(String(code));
        if (!tokens.refresh_token) {
          throw new Error("No refresh token returned by Google");
        }
        const accessToken = tokens.access_token;
        if (!accessToken) {
          throw new Error("No access token returned by Google");
        }
        await assertTokenMatchesAccount(accessToken, accountEmail);

        client.setCredentials(tokens);
        await saveRefreshToken(tokens.refresh_token, accountEmail);

        finish(() => resolve(accessToken));
        return "授权成功，可以回到终端";
      } catch (err) {
        const message = formatErrorMessage(err);
        finish(() => reject(err));
        set.status = 500;
        return `授权失败：${message}`;
      }
    });

    try {
      app.listen(3003);

      const authorizeUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: ["https://mail.google.com"],
        state,
        login_hint: normalizeEmailAddress(accountEmail) || undefined,
      });

      process.stderr.write(`请在浏览器完成 Gmail 授权：\n${authorizeUrl}\n`);
      open(authorizeUrl).catch((err) => finish(() => reject(err)));
    } catch (err) {
      finish(() => reject(err));
    }
  });
}
