/**
 * .txt 分段上传（2026-10-19 用户点名）
 * ================================
 *
 * 用户原话：「网页端是可以这样把文件裁成几段发送的，你可以弄一下，
 * 设置个多少字节截断之类的，你自己弄个默认值。」
 *
 * ## 设计
 *
 * - 大 .txt（> txtChunkBytes，默认 400KB）切成多片，逐片：
 *   「上传 → 等解析 → 立刻点停（这段不需要 AI 回答）→ 清输入框」；
 * - 最后一发不带停——让模型按真问题回答；
 * - 每片文件名带序号（part-1-of-3）——模型读片时能知道上下文是连续的；
 * - 片与片之间保留人工随机间隔（2~4s）；
 * - 首片前发一句「分段说明」正文（纯文字消息），告诉模型接下来是同一份
 *   文档的多个分片，读完最后一片再回答——不点停，让它自然短回应即可。
 *
 * ## 为什么安全
 *
 * - 分段只对**上传通道**生效——正文发送逻辑零改动；
 * - 切割点优先找换行（不拆 UTF-8 字符、不拆句子中段）；
 * - 任何一片失败 ⇒ 整个 job 报错（半份文档比没有更糟）。
 */

/** 默认单片大小：400KB——元宝/DeepSeek 的文档上传上限都在 MB 级，
 *  400KB 留足解析余量且三片能覆盖 1.2MB 会话。 */
export const DEFAULT_TXT_CHUNK_BYTES = 400 * 1024;

/** 按字节上限切文件，优先在换行处切。返回 Buffer 数组。 */
export function chunkFileBytes(buf, maxBytes = DEFAULT_TXT_CHUNK_BYTES) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  if (src.length <= maxBytes) return [src];
  const parts = [];
  let start = 0;
  while (start < src.length) {
    let end = Math.min(start + maxBytes, src.length);
    if (end < src.length) {
      /** 在 [end-4KB, end] 里找最后一个换行，不拆行。 */
      const windowStart = Math.max(start, end - 4096);
      const window = src.subarray(windowStart, end);
      const nl = window.lastIndexOf(0x0a);
      if (nl > 0) end = windowStart + nl + 1;
    }
    parts.push(src.subarray(start, end));
    start = end;
  }
  return parts;
}

/** 给每片起可识别的名字：原名-partN-ofM.ext（去原扩展名再拼）。 */
export function partFileName(original, i, total) {
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : ".txt";
  return `${stem}-part${i + 1}-of${total}${ext}`;
}
