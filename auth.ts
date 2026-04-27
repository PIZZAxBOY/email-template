import { chmod, rename, writeFile } from "node:fs/promises";
import { Elysia } from "elysia";
import { OAuth2Client } from "google-auth-library";
import open from "open";

const CLIENT_SECRET_FILE = "./client_secret.json";
const TOKEN_FILE = "./google_token.json";

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

async function saveRefreshToken(refreshToken: string) {
  const tmpFile = `${TOKEN_FILE}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    tmpFile,
    JSON.stringify({ refresh_token: refreshToken }, null, 2),
    { mode: 0o600 },
  );
  await chmod(tmpFile, 0o600);
  await rename(tmpFile, TOKEN_FILE);
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

export async function getAccessToken(): Promise<string> {
  const secret = await loadClientSecret();
  const client = createOAuthClient(secret);

  if (await Bun.file(TOKEN_FILE).exists()) {
    await chmod(TOKEN_FILE, 0o600).catch(() => undefined);
    const { refresh_token } = await Bun.file(TOKEN_FILE).json();
    if (refresh_token) {
      client.setCredentials({ refresh_token });

      const { token } = await client.getAccessToken();
      if (!token) {
        throw new Error("No access token returned by Google");
      }
      return token;
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

        client.setCredentials(tokens);
        await saveRefreshToken(tokens.refresh_token);

        const { token } = await client.getAccessToken();
        if (!token) {
          throw new Error("No access token returned by Google");
        }

        finish(() => resolve(token));
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
      });

      console.log("请在浏览器完成 Gmail 授权：");
      console.log(authorizeUrl);
      open(authorizeUrl).catch((err) => finish(() => reject(err)));
    } catch (err) {
      finish(() => reject(err));
    }
  });
}
