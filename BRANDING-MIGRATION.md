# ChangYe 命名清理

本次审计覆盖受 Git 管理的源码、测试、构建配置、文档、配套服务插件和重新生成的发布文件，不修改 Git 历史、依赖包、用户保存的工作流或聊天原文。

## 已统一的命名

| 原命名 | 新命名 | 涉及位置 |
| --- | --- | --- |
| `BbiSelect`、`BbiCombo`、`BbiTextarea` | `ChangYeSelect`、`ChangYeCombo`、`ChangYeTextarea` | 组件文件、导入与模板 |
| `BbiImage*`、`BBI_*` | `ChangYeImage*`、`CHANGYE_*` | 类型、常量、构建变量、测试 |
| `bbi-*`、`--bbi-*` | `changye-*`、`--changye-*` | DOM 标识、CSS 类、主题变量、选择器 |
| `bbi_image` | `changye_image` | 新生成的聊天图片标签 |
| `bbiImage`、`bbiCharChanges`、`bbi_prompt_sources` | `changyeImage`、`changyeCharChanges`、`changye_prompt_sources` | 新写入的图片记录、人物变化、选段来源 |
| `baibai_image*` | `changye_image*` | 新写入的设置和人物库 |
| `STBaiBaiImage`、`st-baibai-image:*` | `STChangYeImage`、`st-changye-image:*` | 公开接口、事件 |
| `bbi_` 文件名、`BaiBai` 输出前缀 | `changye_`、`ChangYe` | 新图片、下载、ComfyUI 默认模板 |
| `柏宝绘_` 图片目录 | `长夜绘图器_` | 新图片及画师预览 |
| `baibai_pose` | `changye_pose` | 新上传的姿态参考图 |
| `baibai-image-folders` | `changye-image-folders` | 服务插件目录、标识和路由 |
| `bbiBuild` | `changyeBuild` | 包配置和缓存刷新标识 |

## 有意保留的旧标识

- `src/legacyCompatibility.ts` 集中记录历史存储键、外部 API、共享事件、旧目录和旧 IndexedDB 名称。读取旧数据后正常保存使用新键；已清空的新值优先，不回填旧值。
- 图片解析、正文清洗、选段和输入校验同时识别旧标签。历史提示词原文及其哈希保持不变，避免历史图片失联。
- 图库列出新旧目录，旧图片与侧写文件保留原路径。托管正则升级后只保留一组规则，同时识别两种标签。
- 旧公开 API 与事件作为兼容别名保留。共享渠道与排除设置继续兼容外部插件的旧协议，避免改名切断同步。外部角色记忆插件实际提供的 `STBaiBaiBook` 接口不能被本项目改名。
- 旧 `idb:` 引用继续读原数据库，新本机数据写入 `changye_image_vibes`，以 `idb-changye:` 标识。
- 兼容测试保留旧格式样本；README 和 manifest 保留真实原作署名、仓库链接与许可证信息。
- 现有安装目录无需改名。自动更新按实际加载路径识别扩展，避免产生重复安装。

## 文件夹助手升级

新服务插件位于 `server-plugins/changye-image-folders`。既有安装可用该目录中的文件更新旧助手目录，重启酒馆后加载新路由；不要同时启用两份助手。新助手允许打开新旧图片目录，仍执行原来的用户目录、路径、来源及本机访问校验。前端在新路由不存在时仍可回退旧助手打开历史目录；旧助手不支持新目录时需更新并重启。

## 验证边界

自动化覆盖新旧设置、人物变化、图片标签、历史路径、来源记录、托管正则、公开 API、文件夹助手和 IndexedDB 引用。界面检查使用实际组件；是否已安装、是否已被真实酒馆加载、是否推送 GitHub，以交付消息中的验证结果为准。
