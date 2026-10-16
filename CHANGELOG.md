# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-16

### Added
- First fan release: web app, `irm | iex` installer and extractor, Azure Static Web App with cloud saves,
  update feed, compatibility check and opt-in telemetry.
- "Report a bug" in the start menu, the game menu (Extras) and the battle and cutscene pause windows: opens a
  GitHub issue form with the version, mode, browser, location in the game, asset manifest and recent errors
  filled in. Save summary only if you tick the box.
- Issue forms, security policy, contributing guide, Bicep parameters file and `azd` support.
- Menus in the style of the FF7 Remake on original artwork: main menu with live 3D portraits, Materia & Equipment,
  Inventory, Shop (who can equip, quantity), Options (Game, Controls with key and button rebinding, Display &
  Graphics, Audio, Accessibility with reduced motion), title screen, pause and system menus.
- Battles: Remake-style command menus on the classic ATB with a separate Attack, Guard, shortcuts, enemy HP bars,
  ability banners, a notification feed and a controls guide; keyboard, mouse and gamepad with matching button
  pictures. Field: corner minimap and interaction prompts.
- Streamlined Progression (Options → Game): double EXP and gil, gentler enemies, recovery after battle.
- The title screen offers full screen after the first key press (Options → Display & Graphics → Full Screen at
  Start: Ask, Always or Never).
- The installer rebuilds EC's own battle effects from your install: skill, hit and summon effects, the
  particles placed in battle stages and field maps, and the summon movies. Battle stages get their baked
  lightmaps, emissive lights, normal and occlusion maps, and every map its fog, ambient light, sun and bloom.
  The UI plays EC's menu sounds.
- Running the installer again redoes only what a new release changed, and retries a model that ran out of
  memory on its own.

[Unreleased]: https://github.com/dudhasch/forever-crisis/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dudhasch/forever-crisis/releases/tag/v0.1.0
