// 插件入口。
//
// 这个插件本身不做业务：真正的能力由 server.mjs 以 MCP 服务的形式提供，
// 由本包自带的 cordis.patch.yml 注册（见 scripts/install.mjs）。
// 这里存在的意义是让 DSH 把它当成一个**正常的 bundle**：
//   · 出现在 profile 的 bundles 列表里（插件管理器能看见、能开关）；
//   · 关掉它 = 不加载本包 = 不注册书架 MCP。
export const name = 'dsh-books'

export const inject = []

export function apply(ctx) {
  // 只打一行启动日志，方便在 DSH 日志里确认这个 bundle 真的被装配过。
  // 不碰 ctx.webServer / ctx.tools，避免在不同 DSH 版本里因为缺服务而激活失败。
  try {
    const logger = ctx?.logger ?? console
    logger.info?.('[dsh-books] 书架插件已装载（MCP 工具由 server.mjs 提供）')
  } catch {
    // 日志失败不影响装载
  }
}
