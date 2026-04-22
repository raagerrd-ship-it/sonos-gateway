

# Minnesoptimering för Sonos Buddy på Pi Zero 2 W

## Mål
Sänka RSS för engine (~71 MB) och UI-servern (~18 MB) så vi får marginal mot RAM-taket på Pi Zero 2 W (512 MB totalt, dashboard visar ~89 MB använt av tjänsten).

## Var minnet går idag
- **`sharp` (libvips)** i engine: ensam ansvarig för 30–40 MB RSS. Den lazy-laddar libvips första gången `extractPalette` körs och släpper aldrig minnet.
- **Palette LRU-cache**: 20 entries × 4 färger ≈ försumbart, men `sharp`-pipelinen håller interna buffrar.
- **Node default heap** (~64 MB young + old gen) — för stort för vårt behov.
- **`logBuffer`** (50 entries) och `cloudPushStatus.responseBody` (200 tecken) — små men kan trimmas.
- **SSE-klienter**: varje broadcast bygger en ny JSON-sträng och `{ ...lastSonosEvent }` spread — extra allokeringar varje sekund (position-tick).
- **`bridge/index.js`** är ~1300 rader och duplicerar allt engine gör (parallell process). På bilden ser vi bara Motor + UI, så bridge körs förmodligen inte här — men koden för palette i bridge importerar också `sharp`.

## Åtgärder

### 1. Begränsa Node heap (störst effekt, noll risk)
Lägg till `--max-old-space-size=64` i start-kommandot för engine och `--max-old-space-size=48` för UI. Detta tvingar V8 till tidigare GC istället för att växa till default 64–256 MB. Sätts i:
- `engine/package.json` → `"start": "node --max-old-space-size=64 --max-semi-space-size=2 index.js"`
- UI start-script (samma flagga, lägre värde)
- `service.json` om den definierar startkommando

### 2. Optimera `sharp`-användningen i `engine/palette.js` och `bridge/palette.js`
- Sätt `sharp.cache(false)` och `sharp.concurrency(1)` vid import — stänger av libvips interna pixelcache (default ~50 MB) och trådpool.
- Sänk resize från 30×30 till **20×20** (400 pixlar räcker gott för 4 LED-färger).
- Anropa `sharp.simd(true)` för snabbare bearbetning på ARM.
- Frigör buffert explicit: sätt `imageBuffer = null` efter användning.

```js
// Top of palette.js
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);
sharp.simd(true);
```

Förväntad effekt: −20 till −30 MB RSS i engine.

### 3. Trimma palette-LRU-cache
Sänk `CACHE_MAX` från 20 till **8**. Vi byter sällan mellan fler än ~5 album i kort följd; cache bortom det är onödigt minne.

### 4. Reducera allokeringar i hot path (position-tick varje sekund)
I `engine/index.js`:
- `broadcastSSE`: bygg meddelandet en gång och skriv till varje client istället för att stringify:a per anrop (redan gjort) — men undvik `{ ...lastSonosEvent, palette }` spreads i `palette-update` blocken; muterera lastSonosEvent direkt och skicka det.
- `position-tick`: skicka inte hela tickData när inget ändrats förutom position — UI kan interpolera. Alternativt: höj `POSITION_INTERVAL_MS` default från 1000 → 2000 ms när det inte finns aktiva SSE-clients (redan tidig return) och pausa cloudPush av tick helt om payload är oförändrad bortsett från position.

### 5. Trimma `logBuffer` och cloud-status
- `LOG_BUFFER_SIZE`: 50 → **30**.
- `cloudPushStatus.responseBody` / `error`: substring(0, 200) → **80**.
- Filtrera ut `[DEBUG]` rader från buffern när `process.env.DEBUG` inte är satt (just nu sparas de ändå via `addToLogBuffer` även om de inte loggas).

### 6. Stäng av cloud-push payload-buffring när disabled
`lastCloudPushData` håller en hel payload i minnet. Om `cloudConfig.enabled === false`, hoppa över hela payload-bygget i `cloudPush()` (tidig return finns redan, men nu byggs inte payload — bra). Lägg till samma guard i UI.

### 7. (Valfritt, större förändring) Bryt ut delad palette-modul
Engine och bridge har nu två kopior av samma palette-logik och båda drar in `sharp`. Om `bridge` inte används i drift på denna Pi (skärmbilden visar bara Motor + UI), avinstallera bridge-tjänsten via Pi Control Center → frigör hela bridge-processens RSS.

## Tekniska detaljer

| Område | Nu | Efter | Förväntad besparing |
|---|---|---|---|
| Node heap engine | default (~80 MB tak) | `--max-old-space-size=64` | −10 MB RSS |
| `sharp.cache` | default (~50 MB) | `false` | −15 till −25 MB RSS |
| Resize 30×30 → 20×20 | 2700 px | 1200 px | −1 MB |
| LRU-cache 20 → 8 | ~bagatell | mindre objekt | −0,5 MB |
| logBuffer 50 → 30 | ~50 KB | ~30 KB | försumbart |
| Bridge avinstallerad (om ej använd) | ~50 MB | 0 | −50 MB |

Totalt realistisk besparing: **20–30 MB** i engine + UI utan att röra bridge, **70+ MB** om bridge stängs av.

## Filer som ändras
- `engine/palette.js` — sharp.cache/concurrency/simd, resize 20, fri buffer, CACHE_MAX=8
- `bridge/palette.js` — samma som ovan
- `engine/package.json` — `--max-old-space-size=64` i start-script
- `engine/index.js` — LOG_BUFFER_SIZE=30, response-body trim, debug-buffer guard, mindre spreads i palette-callbacks
- `bridge/index.js` — samma trims (om bridge behålls)
- `service.json` — verifiera att start-kommandot picks up package.json scripts (ingen ändring behövs om så)

## Vad jag INTE rör
- SSE-prenumerationsintervall, UPnP renew-timer, SSDP discovery — redan tunna.
- React UI bundle — körs i webbläsaren, påverkar inte Pi RAM.
- Algoritmen för LED-färgvalet — bara resize-storleken.

