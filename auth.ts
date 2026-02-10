import { OAuth2Client } from "google-auth-library";
import secret from "./client_secret.json";
import { Elysia } from "elysia";
import open from "open";

export async function getAccessToken() {
  const client = new OAuth2Client({
    client_id: secret.installed.client_id,
    client_secret: secret.installed.client_secret,
    redirectUri: secret.installed.redirect_uris[0],
  });

  if (await Bun.file("./google_token.json").exists()) {
    const { refresh_token } = await Bun.file("./google_token.json").json();
    client.setCredentials({ refresh_token });

    const { token } = await client.getAccessToken();
    return token;
  }

  return new Promise((resolve, reject) => {
    const app = new Elysia();

    app.get("/oauth2callback", async ({ query }) => {
      const code = query.code;
      if (!code) return reject(new Error("No authorization code"));

      try {
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        await Bun.write(
          "./google_token.json",
          JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2),
        );

        const { token } = await client.getAccessToken();
        app.stop();
        resolve(token);
        return "授权成功，可以回到终端";
      } catch (err) {
        reject(err);
      }
    });

    app.listen(3003, () => {
      const authorizeUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: ["https://mail.google.com"],
      });

      open(authorizeUrl);
    });
  });
}
