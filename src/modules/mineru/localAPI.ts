/** Thin endpoints on Zotero's loopback server; registered for the plugin lifetime. */
import { config } from "../../../package.json";
import { MineruAPIError } from "./apiError";
import { mineruService, type MineruTaskService } from "./service";

export const localAPIBase = `/${config.addonRef}/v1`;
type Request = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  searchParams?: URLSearchParams;
  query?: Record<string, string>;
  data?: unknown;
};
type Response = [number, string, string];

export function registerLocalAPI(
  service: MineruTaskService = mineruService,
): () => void {
  const registered = new Map<string, Function>();
  for (const route of ["status", "results", "tasks", "tasks/cancel"]) {
    const path = `${localAPIBase}/${route}`;
    class Endpoint {
      supportedMethods =
        route === "tasks"
          ? ["GET", "POST"]
          : route === "tasks/cancel"
            ? ["POST"]
            : ["GET"];
      supportedDataTypes = ["application/json"];
      async init(request: Request): Promise<Response> {
        try {
          // Native connector headers can bypass Zotero's browser guard.
          if (
            Object.keys(request.headers).some(
              (key) => key.toLowerCase() === "origin",
            )
          )
            throw new MineruAPIError(
              403,
              "browser_origin_denied",
              "Use a local client without a browser Origin",
            );
          const query = (key: string) =>
            request.searchParams?.get(key) ?? request.query?.[key];
          let data: unknown;
          if (route === "status") data = await service.status();
          else if (route === "results")
            data = await service.results({
              libraryID: Number(query("libraryID")),
              itemKey: query("itemKey"),
            });
          else if (route === "tasks/cancel") {
            const body = request.data as { taskID?: unknown };
            if (
              !body ||
              typeof body.taskID !== "string" ||
              Object.keys(body).some((key) => key !== "taskID")
            )
              throw new MineruAPIError(
                400,
                "invalid_request",
                "Provide taskID",
              );
            data = service.cancel(body.taskID);
          } else if (request.method === "POST")
            data = await service.submit(request.data);
          else {
            const id = query("taskID");
            if (!id)
              throw new MineruAPIError(
                400,
                "invalid_request",
                "Provide taskID",
              );
            data = service.get(id);
          }
          return [
            route === "tasks" &&
            request.method === "POST" &&
            (data as { disposition?: string }).disposition === "created"
              ? 201
              : 200,
            "application/json",
            JSON.stringify(data),
          ];
        } catch (error) {
          if (error instanceof MineruAPIError)
            return [
              error.status,
              "application/json",
              JSON.stringify({
                error: {
                  code: error.code,
                  message: error.message,
                  ...error.details,
                },
              }),
            ];
          Zotero.logError(error as Error);
          return [
            500,
            "application/json",
            JSON.stringify({
              error: {
                code: "internal_error",
                message: "Plugin operation failed; inspect the Zotero log",
              },
            }),
          ];
        }
      }
    }
    Zotero.Server.Endpoints[path] = Endpoint;
    registered.set(path, Endpoint);
  }
  return () => {
    for (const [path, endpoint] of registered)
      if (Zotero.Server.Endpoints[path] === endpoint)
        delete Zotero.Server.Endpoints[path];
  };
}
