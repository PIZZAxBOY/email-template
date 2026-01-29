import { Elysia, file } from "elysia";

const app = new Elysia();

app
  .get("/:id", ({ params: { id } }) => file(`./image/${id}`))
  .listen(3002, ({ url }) => console.log("listening on:", url.href));
