import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
const root=fileURLToPath(new URL("../../",import.meta.url));
async function files(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(path.endsWith(".ts"))result.push(path);}return result;}
function importSpecs(path, text, runtimeOnly = false) {
 const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
 const specs = [];
 const visit = node => {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
   let typeOnly = node.isTypeOnly || node.importClause?.isTypeOnly;
   if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0)
     typeOnly ||= bindings.elements.every(element => element.isTypeOnly);
   } else if (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0) {
    typeOnly ||= node.exportClause.elements.every(element => element.isTypeOnly);
   }
   if (!runtimeOnly || !typeOnly) specs.push(node.moduleSpecifier.text);
  } else if (ts.isCallExpression(node) &&
   (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
   node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
   specs.push(node.arguments[0].text);
  }
  ts.forEachChild(node, visit);
 };
 visit(source);
 return specs;
}
async function imports(path, runtimeOnly = false) {
 return importSpecs(path, await readFile(path, "utf8"), runtimeOnly);
}

test("runtime boundary tracing ignores only type-only dependencies", () => {
 const text = `
  import type { Database } from "bun:sqlite";
  import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
  export type { AgentPort } from "./frontend.ts";
  export { type Peer } from "./types.ts";
  import { type Task, TaskSchema } from "./domain.ts";
  import "./side-effect.ts";
  export * from "./reexport.ts";
  const later = import("./dynamic.ts");
  const required = require("./required.ts");
 `;
 assert.deepEqual(importSpecs("fixture.ts", text, true), [
  "./domain.ts", "./side-effect.ts", "./reexport.ts", "./dynamic.ts", "./required.ts",
 ]);
});

test("server has no transitive Bun or Pi runtime dependencies", async () => {
 const seen = new Set();
 const visit = async path => {
  if (seen.has(path)) return;
  seen.add(path);
  for (const spec of await imports(path, true)) {
   assert.equal(/^(?:bun:|@earendil-works\/|@mariozechner\/)/.test(spec), false, `${path}: ${spec}`);
   if (spec.startsWith(".")) {
    const target = resolve(dirname(path), spec);
    assert.equal(target.startsWith(resolve(root, "src/bot")), false, `${path}: ${spec}`);
    await visit(target);
   }
  }
 };
 await visit(resolve(root, "src/agent-bridge/server.ts"));
});
test("daemon infrastructure never imports Pi code or SDKs",async()=>{
 for(const path of await files(resolve(root,"src/agent-bridge")))for(const spec of await imports(path)){
  assert.equal(spec.startsWith("@earendil-works/"),false,`${path}: ${spec}`);
  if(spec.startsWith("."))assert.equal(resolve(dirname(path),spec).startsWith(resolve(root,"src/bot")),false,`${path}: ${spec}`);
 }
});
test("Pi integration reaches bridge only through portable client and protocol",async()=>{
 const bridge=resolve(root,"src/agent-bridge");const allowed=new Set([resolve(bridge,"client.ts"),resolve(bridge,"protocol.ts")]);
 for(const path of await files(resolve(root,"src/bot")))for(const spec of await imports(path))if(spec.startsWith(".")){
  const target=resolve(dirname(path),spec);if(target.startsWith(bridge))assert.ok(allowed.has(target),`${path}: ${spec}`);
 }
 const seen=new Set();const visit=async path=>{if(seen.has(path))return;seen.add(path);for(const spec of await imports(path)){
  assert.equal(spec.startsWith("bun:"),false,`${path}: ${spec}`);assert.equal(spec.startsWith("@earendil-works/"),false,`${path}: ${spec}`);
  if(spec.startsWith(".")){const target=resolve(dirname(path),spec);assert.ok(allowed.has(target),`Portable client imported daemon code: ${target}`);await visit(target);}
 }};await visit(resolve(bridge,"client.ts"));
});
