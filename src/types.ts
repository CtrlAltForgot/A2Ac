export type Identity = { name: string; role: "human" | "agent" | "admin" };

export type EventInput = {
  channel?: string;
  kind: string;
  summary: string;
  detail?: unknown;
  taskId?: number;
  parentId?: number;
};
