import {
  type BuilderDocument,
  type ElementNode,
  findNode,
  mapNode,
  removeNode,
} from "./document";

/**
 * Collaborative editing operations for a canvas document. These mirror the
 * mutations in the editor's `useBuilderDocument` hook and are the unit of
 * exchange between clients and the page's Durable Object: each client emits an
 * op, the DO applies it to the authoritative draft and rebroadcasts it. Because
 * the DO serializes messages, applying ops in receive order is conflict-free.
 */
export type CanvasOp =
  | { kind: "replace_node"; nodeId: string; node: ElementNode }
  | { kind: "insert_node"; node: ElementNode; parentId: string | null; index: number }
  | { kind: "move_node"; nodeId: string; parentId: string | null; index: number }
  | { kind: "remove_node"; nodeId: string }
  | { kind: "patch_tokens"; patch: Record<string, unknown> }
  | { kind: "replace_document"; doc: BuilderDocument };

/** Parent id + index of a node within its parent's children (or root body). */
export function locateNode(
  body: ElementNode[],
  id: string,
): { parentId: string | null; index: number } | null {
  const rootIdx = body.findIndex((n) => n.id === id);
  if (rootIdx !== -1) return { parentId: null, index: rootIdx };
  const walk = (
    nodes: ElementNode[],
  ): { parentId: string | null; index: number } | null => {
    for (const n of nodes) {
      const idx = n.children.findIndex((c) => c.id === id);
      if (idx !== -1) return { parentId: n.id, index: idx };
      const deep = walk(n.children);
      if (deep) return deep;
    }
    return null;
  };
  return walk(body);
}

/** Immutably insert a node under a parent (null = root body) at an index. */
function insertInto(
  body: ElementNode[],
  node: ElementNode,
  parentId: string | null,
  index: number,
): ElementNode[] {
  if (parentId === null) {
    const arr = [...body];
    arr.splice(Math.min(Math.max(index, 0), arr.length), 0, node);
    return arr;
  }
  return mapNode(body, parentId, (p) => {
    const children = [...p.children];
    children.splice(Math.min(Math.max(index, 0), children.length), 0, node);
    return { ...p, children };
  });
}

/** Apply an op to a document, returning a new document (pure). */
export function applyCanvasOp(doc: BuilderDocument, op: CanvasOp): BuilderDocument {
  switch (op.kind) {
    case "replace_node":
      return { ...doc, body: mapNode(doc.body, op.nodeId, () => op.node) };
    case "insert_node":
      // Idempotency: if the id already exists in the tree the op is a duplicate
      // (resent after a reconnection, or applied twice through different paths).
      // Inserting it again would create two nodes with the same id: "ghost
      // duplicates" that get deleted together and break the selection.
      if (findNode(doc.body, op.node.id)) return doc;
      return { ...doc, body: insertInto(doc.body, op.node, op.parentId, op.index) };
    case "remove_node":
      return { ...doc, body: removeNode(doc.body, op.nodeId) };
    case "move_node": {
      const node = findNode(doc.body, op.nodeId);
      if (!node) return doc;
      // Reparenting into own descendant is not allowed.
      if (op.parentId && findNode(node.children, op.parentId)) return doc;
      const without = removeNode(doc.body, op.nodeId);
      return { ...doc, body: insertInto(without, node, op.parentId, op.index) };
    }
    case "patch_tokens":
      return { ...doc, tokens: { ...doc.tokens, ...op.patch } };
    case "replace_document":
      return op.doc;
  }
}

/**
 * Compute the inverse of an op given the document *before* it is applied, so an
 * editor can implement undo/redo as op emission (works in collaboration).
 * Returns null when the op cannot be inverted meaningfully.
 */
export function invertCanvasOp(doc: BuilderDocument, op: CanvasOp): CanvasOp | null {
  switch (op.kind) {
    case "replace_node": {
      const prev = findNode(doc.body, op.nodeId);
      return prev ? { kind: "replace_node", nodeId: op.nodeId, node: prev } : null;
    }
    case "insert_node":
      return { kind: "remove_node", nodeId: op.node.id };
    case "remove_node": {
      const node = findNode(doc.body, op.nodeId);
      const loc = locateNode(doc.body, op.nodeId);
      if (!node || !loc) return null;
      return { kind: "insert_node", node, parentId: loc.parentId, index: loc.index };
    }
    case "move_node": {
      const loc = locateNode(doc.body, op.nodeId);
      if (!loc) return null;
      return { kind: "move_node", nodeId: op.nodeId, parentId: loc.parentId, index: loc.index };
    }
    case "patch_tokens": {
      const prev: Record<string, unknown> = {};
      const tokens = doc.tokens as Record<string, unknown>;
      for (const key of Object.keys(op.patch)) prev[key] = tokens[key];
      return { kind: "patch_tokens", patch: prev };
    }
    case "replace_document":
      return { kind: "replace_document", doc };
  }
}

/**
 * Nodes an op touches for lock enforcement, plus whether it is page-level
 * (tokens / whole-document), which requires that no one else holds a lock.
 */
export function affectedNodeIds(op: CanvasOp): {
  nodes: string[];
  pageLevel: boolean;
} {
  switch (op.kind) {
    case "replace_node":
      return { nodes: [op.nodeId], pageLevel: false };
    case "remove_node":
      return { nodes: [op.nodeId], pageLevel: false };
    case "insert_node":
      return { nodes: op.parentId ? [op.parentId] : [], pageLevel: op.parentId === null };
    case "move_node":
      return {
        nodes: op.parentId ? [op.nodeId, op.parentId] : [op.nodeId],
        pageLevel: op.parentId === null,
      };
    case "patch_tokens":
    case "replace_document":
      return { nodes: [], pageLevel: true };
  }
}

/** True when `ancestorId`'s subtree contains `descId` (strictly below it). */
export function isAncestorOf(
  body: ElementNode[],
  ancestorId: string,
  descId: string,
): boolean {
  const anc = findNode(body, ancestorId);
  return !!anc && !!findNode(anc.children, descId);
}
