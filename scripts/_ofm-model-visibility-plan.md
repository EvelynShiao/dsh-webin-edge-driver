/**
 * OFM 每模型显示开关（2026-10-20 用户点名）
 * ============================================
 * 「顺便给 OFM 插件的每个模型加个是否显示在模型选择页的按钮」
 *
 * ## 设计
 *
 * - 设置里存 `hiddenModels: string[]`（模型 id 列表）；
 * - `listModels` 过滤掉隐藏的（resolveModel 不过滤——旧会话里已选中的仍能用，
 *   只是选择页不再显示）；
 * - 设置页（Roster 卡片）每个模型加显隐小开关。
 *
 * ## 接线
 *
 * ① sanitizeSettings 认识 hiddenModels（数组字符串白名单）；
 * ② /settings POST 的 pick 列表加 hiddenModels；
 * ③ adapter.listModels 过滤；
 * ④ Roster 卡片加按钮。
 */
