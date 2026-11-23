# 录歌与练唱分析

导入人声录音，或用麦克风跟伴奏录唱。加载练习示例可以体验音高曲线、逐音偏差和分段回听。音频在浏览器本地处理，新录的人声可保存为 WAV。

- [公开练唱页](https://archili2035.github.io/SongPractice/)
- [站点入口文件](docs/song-practice_index.html)

## 本地预览

在仓库根目录运行下面的命令，然后打开 http://localhost:4399/。使用麦克风需要 HTTPS 或 localhost。

```powershell
python -m http.server 4399 --bind 127.0.0.1 --directory docs
```

站点通过 GitHub Pages 从 main 分支的 docs 目录发布。门户读取根目录的 portal.json 和 docs 内的站点资源。
