import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { type Container, IncomingMessageSchema } from "../../src/agent-bridge/domain.ts";
import { Router } from "../../src/agent-bridge/router.ts";
import { Store } from "../../src/agent-bridge/store.ts";

test("default, custom cwd, creator, and unconfirmed visible-writer leases survive database reopening", () => {
  const root=mkdtempSync(join(tmpdir(),"thread-persist-"));const path=join(root,"bridge.sqlite");
  let store=new Store(path);
  try {
    const project=store.registerProject("/repo");const container:Container={platform:"telegram",spaceId:"group",channelId:"topic"};
    store.bind({container,projectId:project.id});const routed=new Router(store).route(v.parse(IncomingMessageSchema,{id:"1",container,authorId:"7",text:"hello",route:{kind:"default"}}));
    if(routed.kind!=="routed")throw new Error("Missing default");const task=routed.task;
    store.configureThread(task.id,"/worktree","task_creator");store.attachTask({taskId:task.id,sessionId:"visible",sessionFile:"/saved.jsonl",ownerId:"7"});store.markVisibleWriter(task.id,"visible");
    store.close();store=new Store(path);
    expect(store.defaultTask(container)?.id).toBe(task.id);
    expect(store.threadSettings(task)).toEqual({cwd:"/worktree",isDefault:true,parentThreadId:"task_creator"});
    expect(store.visibleWriter(task.id)).toBe("visible");expect(store.taskAttachment(task.id)?.sessionFile).toBe("/saved.jsonl");
    store.detachTask(task.id);expect(store.visibleWriter(task.id)).toBeUndefined();expect(store.taskAttachment(task.id)).toBeNull();expect(store.task(task.id)).not.toBeNull();
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

for (const platform of ["telegram", "discord", "slack"] as const) {
  test(`${platform}: default routing is per project space and explicit threads bypass it`, () => {
    const store = new Store(":memory:");
    try {
      const project = store.registerProject("/repo");
      const container: Container = { platform, spaceId: "community", channelId: "one" };
      const other: Container = { ...container, channelId: "two" };
      store.bind({container, projectId:project.id}); store.bind({container:other, projectId:project.id});
      const router = new Router(store);
      const message = (id: string, space=container, route: unknown={kind:"default"}) => v.parse(IncomingMessageSchema,{id,container:space,authorId:"user",text:"request",route});
      const main = router.route(message("1"));const continuation = router.route(message("2"));const second = router.route(message("3",other));
      expect(main.kind).toBe("routed");expect(continuation.kind).toBe("routed");expect(second.kind).toBe("routed");
      if (main.kind!=="routed"||continuation.kind!=="routed"||second.kind!=="routed") throw new Error("Missing defaults");
      expect(main.task.id).toBe(continuation.task.id);expect(main.task.id).not.toBe(second.task.id);
      expect(store.threadSettings(main.task).isDefault).toBe(true);
      const child=router.route(message("4",container,{kind:"start",rootId:"4"}));if(child.kind!=="routed")throw new Error("Missing child");
      const reply=router.route(message("5",container,{kind:"reply",parentId:"4"}));if(reply.kind!=="routed")throw new Error("Missing reply");
      expect(reply.task.id).toBe(child.task.id);expect(store.threadSettings(child.task).isDefault).toBe(false);
      const next=router.route(message("6"));if(next.kind!=="routed")throw new Error("Missing default");expect(next.task.id).toBe(main.task.id);
      store.unbind(container);const replacement=store.registerProject("/replacement");store.bind({container,projectId:replacement.id});
      const fresh=router.route(message("7"));if(fresh.kind!=="routed")throw new Error("Missing replacement");expect(fresh.task.id).not.toBe(main.task.id);
      expect(router.route(message("8",container,{kind:"reply",parentId:"1"}))).toMatchObject({kind:"ignored",reason:"project-changed"});
    } finally { store.close(); }
  });
}
