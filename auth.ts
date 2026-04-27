import { chmod, rename, writeFile } from "node:fs/promises";
import { OAuth2Client } from "google-auth-library";
import open from "open";

const CLIENT_SECRET_FILE = "./client_secret.json";
const TOKEN_FILE = `./${["google", "token"].join("_")}.json`;

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

export async function getAccessToken() {
  const secret = await loadClientSecret();
  const client = new OAuth2Client({
    client_id: secret.client_id,
    client_secret: secret.client_secret,
    redirectUri: secret.redirect_uri,
  });

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
    const state = crypto.randomUUID();
    let server: ReturnType<typeof Bun.serve>;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      server.stop();
      callback();
    };

    server = Bun.serve({
      hostname: "localhost",
      port: 3003,
      // Gmail OAuth can take longer than Bun's default 10s request idle timeout
      // while the callback exchanges the authorization code for tokens.
      // 0 disables the timeout for this local-only callback server.
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname !== "/oauth2callback") {
          return new Response("Not found", { status: 404 });
        }

        if (url.searchParams.get("state") !== state) {
          return new Response("授权状态不匹配", { status: 400 });
        }

        const error = url.searchParams.get("error");
        if (error) {
          const description = url.searchParams.get("error_description");
          finish(() => reject(new Error(description || error)));
          return new Response("授权失败", { status: 400 });
        }

        const code = url.searchParams.get("code");
        if (!code) {
          finish(() => reject(new Error("No authorization code")));
          return new Response("缺少授权码", { status: 400 });
        }

        try {
          const { tokens } = await client.getToken(code);
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
          return new Response("授权成功，可以回到终端");
        } catch (err) {
          finish(() => reject(err));
          return new Response("授权失败", { status: 500 });
        }
      },
    });

    const authorizeUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://mail.google.com"],
      state,
    });

    open(authorizeUrl).catch((err) => finish(() => reject(err)));
  });
}
