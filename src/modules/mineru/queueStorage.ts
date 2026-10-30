/** Private durable snapshot mechanics; the task module owns the schema and policy. */
export class QueueStorage {
  readonly path: string;
  constructor(readonly root: string) {
    if (!PathUtils.isAbsolute(root))
      throw new Error("Queue root must be absolute");
    this.path = PathUtils.join(root, "queue.json");
  }

  async read(): Promise<unknown | undefined> {
    await IOUtils.makeDirectory(this.root, {
      createAncestors: true,
      permissions: 0o700,
    });
    if (!(await IOUtils.exists(this.path))) {
      // A leftover first-write temporary snapshot is not an empty queue.
      if (await IOUtils.exists(`${this.path}.tmp`))
        throw new Error("Unconfirmed queue snapshot requires inspection");
      return undefined;
    }
    return JSON.parse(await IOUtils.readUTF8(this.path));
  }

  async write(state: unknown): Promise<void> {
    await IOUtils.writeUTF8(this.path, JSON.stringify(state), {
      tmpPath: `${this.path}.tmp`,
      flush: true,
    });
  }
}
