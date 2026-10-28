/**
 * 运行时配置。
 *
 * 依赖字段与父子字段都由页面下拉框选择并持久化；这里只放附加信息字段名与跳转规则。
 * 这些字段缺失时图仍能正常绘制，只是节点少显示一些内容。
 */
export const config = {
  /** 可选的附加字段名；表中不存在时自动跳过 */
  optionalFields: {
    status: '状态',
    tags: '标签',
    dueDate: '截止时间',
    didaId: 'didaId',
    projectId: 'projectId',
    /** 所属清单（select 字段，如「分组」） */
    list: '分组',
    /** 任务内容（多行文本）。按候选顺序探测第一个存在的字段 */
    descriptionCandidates: ['描述', '内容', '详情', '备注', '说明', 'description', 'content'],
  },

  /**
   * 滴答网页版任务直达链接（在客户端内可点击打开，不会触发协议确认弹窗）。
   *   https://dida365.com/webapp/#p/<projectId>/tasks/<taskId>
   */
  didaWebTaskUrl: (projectId: string, didaId: string) =>
    `https://dida365.com/webapp/#p/${projectId}/tasks/${didaId}`,

  /**
   * 滴答搜索跳转（官方 URL Scheme）。
   *
   * 帮助中心《滴答清单 iOS 快捷指令和 URL Scheme》：
   *   ticktick://v1/search?keyword=<关键字>
   *
   * 注意：
   * - 官方只提供「添加任务 / 显示清单 / 搜索」三类指令，没有按 taskId 直达的 scheme，
   *   所以只能搜索后从结果里点开那一条。
   * - 从 http 源（非 localhost）唤起时，飞书内置 Chromium 每次都会弹一次
   *   「要打开此应用吗」确认，且不提供「记住」。这是浏览器安全策略，页面无法绕开；
   *   部署到 https（飞书托管）后才会出现「记住我的选择」。
   */
  didaSearchScheme: (keyword: string) => {
    // 去掉 emoji 再搜，命中率更高（客户端搜索不索引 emoji）
    const cleaned = keyword
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return `ticktick://v1/search?keyword=${encodeURIComponent(cleaned || keyword)}`
  },
}
