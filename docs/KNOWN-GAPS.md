# Known gaps

## Names that show an id instead of text

The explorer's text templates were built against an older MasterData snapshot. Steam's 2026-10-06 update pruned
the game's `MasterData` folder (1,618 files instead of 2,440), and the removed rows no longer exist anywhere in a
current install. This was measured against `StreamingAssets/MasterData`, the Lua and data bundles, all 53k small
`data/`, `outgame/`, `story/` and `scenes/` bundles, `data.unity3d` and the IL2CPP metadata.

On the maintainer's install, 2,035 of the 23,008 referenced strings (about 9 %) cannot be rebuilt. Most of them
are names from the reward, dungeon, shop, skill, weapon, story-episode and costume tables. Rather than blank
names, the extractor shows the row id (`#210153`, `Skill`) for names and titles and leaves other texts and
grouping labels empty; the explorer already skips empty labels.

The count is printed as a warning at the end of the text phase and stored as `stats.textMissing` in
`ffcx-manifest.json`. To check it on your install (text phase only, about 20 s):

```powershell
ffcx extract --game <game folder> --out <install folder> --only text
```
