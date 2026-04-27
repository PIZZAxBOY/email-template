import { chmod, rename, writeFile } from "node:fs/promises";
import { OAuth2Client } from "google-auth-library";
import open from "open";

const CLIENT_SECRET_FILE = "./client_secret.json";
const TOKEN_FILE = `./${["google", "token"].join("_")}.json`;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

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

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
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

function formatGoogleTokenError(data: GoogleTokenResponse | string, status: number) {
  if (typeof data === "string") {
    return data || `HTTP ${status}`;
  }

  return [data.error, data.error_description || `HTTP ${status}`]
    .filter(Boolean)
    .join(": ");
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function requestGoogleToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Google OAuth 网络请求失败: ${formatErrorMessage(error)}`);
  }

  const text = await response.text();
  let data: GoogleTokenResponse | string = text;
  try {
    data = JSON.parse(text) as GoogleTokenResponse;
  } catch {
    // Keep the original text for diagnostics without printing request secrets.
  }

  if (!response.ok) {
    throw new Error(`Google OAuth token 请求失败: ${formatGoogleTokenError(data, response.status)}`);
  }

  if (typeof data === "string") {
    throw new Error("Google OAuth token 响应不是 JSON");
  }

  return data;
}

async function refreshAccessToken(secret: InstalledClientSecret, refreshToken: string) {
  const tokens = await requestGoogleToken(
    new URLSearchParams({
      client_id: secret.client_id,
      client_secret: secret.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  );

  if (!tokens.access_token) {
    throw new Error("No access token returned by Google");
  }

  return tokens.access_token;
}

async function exchangeAuthorizationCode(secret: InstalledClientSecret, code: string) {
  const tokens = await requestGoogleToken(
    new URLSearchParams({
      client_id: secret.client_id,
      client_secret: secret.client_secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: secret.redirect_uri,
    }),
  );

  if (!tokens.refresh_token) {
    throw new Error("No refresh token returned by Google");
  }
  if (!tokens.access_token) {
    throw new Error("No access token returned by Google");
  }

  await saveRefreshToken(tokens.refresh_token);
  return tokens.access_token;
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
      return await refreshAccessToken(secret, refresh_token);
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
          const token = await exchangeAuthorizationCode(secret, code);
          finish(() => resolve(token));
          return new Response("授权成功，可以回到终端");
        } catch (err) {
          const message = formatErrorMessage(err);
          finish(() => reject(err));
          return new Response(`授权失败：${message}`, { status: 500 });
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
