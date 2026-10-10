// A book extraction turn has zero execution capabilities, including inherited
// global/MCP and future tools. Guard is deliberately independent of tool names.
export const name = 'book-tool-deny';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => 'Book extraction is data-only; every tool is denied');
}
