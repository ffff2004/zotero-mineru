/** Thin versioned transport on Zotero's loopback server. */
import { config } from "../../../package.json";
import { MineruAPIError } from "./apiError";
import { mineruService, type MineruTaskService } from "./service";

export const localAPIBase = `/${config.addonRef}/v2`;
export const legacyLocalAPIBase = `/${config.addonRef}/v1`;
type Request = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  searchParams?: URLSearchParams;
  query?: Record<string, string>;
  data?: unknown;
};
type Response = [number, string, string];

function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new MineruAPIError(
      400,
      "invalid_request",
      `Provide ${keys.join(", ")}`,
    );
  return value as Record<string, unknown>;
}
function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new MineruAPIError(400, "invalid_request", `Provide ${name}`);
  return value;
}

export function registerLocalAPI(
  service: MineruTaskService = mineruService,
): () => void {
  const registered = new Map<string, Function>();
  for (const base of [localAPIBase, legacyLocalAPIBase]) {
    const routes =
      base === legacyLocalAPIBase
        ? ["status", "results", "tasks", "tasks/cancel"]
        : [
            "status",
            "results",
            "tasks",
            "tasks/cancel",
            "queue",
            "queue/pause",
            "queue/resume",
            "queue/move",
            "batches",
            "batches/cancel",
          ];
    for (const route of routes) {
      const path = `${base}/${route}`;
      class Endpoint {
        supportedMethods = ["tasks", "batches"].includes(route)
          ? ["GET", "POST"]
          : route.includes("/")
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
            if (base === legacyLocalAPIBase && route.startsWith("tasks"))
              throw new MineruAPIError(
                409,
                "upgrade_required",
                "Task operations require queue protocol v2; upgrade the client",
                { protocolVersion: 2, base: localAPIBase },
              );
            const query = (key: string) =>
              request.searchParams?.get(key) ?? request.query?.[key];
            let data: unknown;
            let created = false;
            if (route === "status") data = await service.status();
            else if (route === "results")
              data = await service.results({
                libraryID: Number(query("libraryID")),
                itemKey: query("itemKey"),
              });
            else if (route === "queue") data = service.getQueue();
            else if (route === "queue/pause") {
              body(request.data ?? {}, []);
              data = await service.pause();
            } else if (route === "queue/resume") {
              body(request.data ?? {}, []);
              data = await service.resume();
            } else if (route === "queue/move") {
              const raw = body(request.data, ["taskID", "before", "after"]);
              const position: { before?: string; after?: string } = {};
              if (raw.before !== undefined)
                position.before = identifier(raw.before, "before");
              if (raw.after !== undefined)
                position.after = identifier(raw.after, "after");
              data = await service.move(
                identifier(raw.taskID, "taskID"),
                position,
              );
            } else if (route === "tasks/cancel") {
              const raw = body(request.data, ["taskID"]);
              data = await service.cancel(identifier(raw.taskID, "taskID"));
            } else if (route === "batches/cancel") {
              const raw = body(request.data, ["batchID"]);
              data = await service.cancelBatch(
                identifier(raw.batchID, "batchID"),
              );
            } else if (route === "batches") {
              if (request.method === "POST")
                data = await service.submitBatch(request.data);
              else
                data = service.getBatch(
                  identifier(query("batchID"), "batchID"),
                );
            } else if (request.method === "POST") {
              data = await service.submit(request.data);
              created =
                (data as { disposition: string }).disposition === "created";
            } else data = service.get(identifier(query("taskID"), "taskID"));
            return [
              created ? 201 : 200,
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
  }
  return () => {
    for (const [path, endpoint] of registered)
      if (Zotero.Server.Endpoints[path] === endpoint)
        delete Zotero.Server.Endpoints[path];
  };
}
