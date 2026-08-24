# Upstream tracking — AlexxIT/WebRTC → fuzzybear62/webrtc

Storia delle **issue** e **pull request** dell'upstream [AlexxIT/WebRTC](https://github.com/AlexxIT/WebRTC)
valutate per questo fork, con il loro stato *qui*. L'upstream è fermo da ~9 mesi (ultimo commit master
2025-11-26) e non processa né PR né issue; questo file è la memoria di cosa il fork già risolve, cosa
integra corretto, e cosa è rimandato.

Legenda stato: **RISOLTA** (già nel fork) · **MITIGATA** (sintomo eliminato, causa radice fuori scope) ·
**DA INTEGRARE** · **DA RISCRIVERE** (valida ma va adattata/corretta) · **RIMANDATA** · **SUPERATA** ·
**GIÀ COPERTA** · **N/A**.

---

## Issue

| Issue | Titolo | Stato nel fork | Evidenza / note |
|---|---|---|---|
| [#886](https://github.com/AlexxIT/WebRTC/issues/886) | InvalidStateError a video-rtc.js:452 (Safari, ogni reload) | **RISOLTA** | L'intero blocco memory-management dell'handler `updateend` è in `try/catch` — l'accesso `sb.buffered` che lancia su teardown è coperto. `video-rtc.js` (handler `updateend`, blocco `try { … } catch (e) { /* ignore */ }`). Upstream avvolge solo `appendBuffer`, non `sb.buffered`. |
| [#901](https://github.com/AlexxIT/WebRTC/issues/901) | Constant Buffering / Freezing (multi-camera) | **RISOLTA** | Stessa causa e stesso fix di #886 (stesso `sb.buffered` non guardato). Un solo try/catch copre entrambe. |
| [#871](https://github.com/AlexxIT/WebRTC/issues/871) | WebRTC non si reinizializza dopo switch da MSE (schermo nero) | **MITIGATA** | Causa radice = incompatibilità codec reale (`H265, AAC` non passano su WebRTC; negoziazione fatta da go2rtc) → non risolvibile lato card. Il fork **elimina il sintomo**: al fallimento RTC `failWebRTC` → `_revertToWarmMSE` torna allo stream MSE caldo invece di lasciare overlay congelato. |

## Pull Request

| PR | Titolo | Stato nel fork | Note |
|---|---|---|---|
| [#938](https://github.com/AlexxIT/WebRTC/pull/938) | Fix InvalidStateError crash in MSE updateend handler | **GIÀ COPERTA** | Coincide con il nostro fix di #886/#901. Conferma indipendente (autore vinnybad: 4 camere, crash ogni ~10s → 0 dopo). Upstream non l'ha mergiata. |
| [#916](https://github.com/AlexxIT/WebRTC/pull/916) | Update go2rtc to 1.9.13 | **SUPERATA** | Il fork è già a go2rtc **1.9.14** (`utils.py` `BINARY_VERSION`). |
| [#951](https://github.com/AlexxIT/WebRTC/pull/951) | Only fall back to muted playback on NotAllowedError | **INTEGRATA** (v14.2.17) | Fallback muted ora gated su `er.name === 'NotAllowedError'` in `play()` (`video-rtc.js`), gli altri errori vengono loggati non mutati. |
| [#961](https://github.com/AlexxIT/WebRTC/pull/961) | Prevent TypeError in ws_poster when image is None | **INTEGRATA** (v14.2.17) | `len(image) if image else 0` nel debug log di `ws_poster` (`__init__.py`). |
| [#942](https://github.com/AlexxIT/WebRTC/pull/942) | Fix media_player.play_media by using go2rtc /api/ffmpeg | **GIÀ COPERTA** (da confermare) | `media_player.py` costruisce già `ffmpeg:{media_id}` come src. Verificare equivalenza col diff. |
| [#956](https://github.com/AlexxIT/WebRTC/pull/956) | Reject invalid/expired authSig with 403 (avoid HA IP bans) | **INTEGRATA** (v14.2.17) | Due `raise HTTPUnauthorized()` → `HTTPForbidden()` (`__init__.py`: validate_signed_request e cookie HLS); import `HTTPUnauthorized` rimosso perché morto. **Più rilevante per il fork** che per upstream: la nostra riconnessione aggressiva (shadow + reprobe + teardown-recreate) rende più probabile l'auto-ban IP su 401. Rischio minimo. |
| [#923](https://github.com/AlexxIT/WebRTC/pull/923) | Use WebRTC ICE configured by Home Assistant | **DA RISCRIVERE · RIMANDATA** | Feature valida (TURN/STUN da HA/Nabu Casa). Non mergiabile: (1) import `homeassistant.components.web_rtc` non guardato e probabilmente errato (path moderno ~ `homeassistant.components.camera.webrtc`) → crash all'import se assente; (2) la PR assume ereditarietà, il fork è a **composizione** (`WebRTCCamera extends HTMLElement`, `pcConfig` sul driver ricreato a ogni nuke) → fetch va fatto **card-level** e iniettato in ogni nuovo driver, con gestione timing della prima RTC. Implementazione **rimandata** per decisione utente (2026-08-24). |
| [#951]/[#954]/[#945]/[#922]/[#890]/[#668]/[#622] | feature varie (muted, volume_entity, live indicator, stream icon, tap_action, refresh IDLE/STREAMING) | **DA VALUTARE a domanda** | Cherry-pick guidato dalla richiesta utenti. #668 (tap_action) è il più richiesto. |
| [#944](https://github.com/AlexxIT/WebRTC/pull/944) | Update README | **N/A** | README del fork è indipendente. |

---

## Ordine di implementazione concordato

1. **CI** — GitHub Actions: `hassfest` + `HACS validate` (requisito di credibilità del repo HACS).
2. **Quick wins** in un unico giro con test: **#956** (403), **#951** (muted NotAllowedError), **#961** (ws_poster guard).
3. **#923** (ICE da HA) — step dedicato successivo, riscritto e validato su rete remota (RIMANDATO).
4. Feature opzionali a domanda.

> Tenere questo file aggiornato a ogni PR/issue upstream valutata o integrata, e allineato con `ARCHITECTURE.md`.
