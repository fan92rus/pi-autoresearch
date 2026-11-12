# Design: expedition-tui

Все четыре улучшения — **read-only презентация** существующих on-disk артефактов
(chain.json, state.json, brief.json, log.jsonl, evidence/). Нового состояния, новых тулов,
новых записей журнала — нет. Хеш-цепочка в рендерах не валидируется (тот же подход, что у
виджета: «map intentionally does not verify journal hashes»).

---

## D1. Архитектура: один чистый модуль-ридер, три потребителя

```
                    ┌──────────────────────────────────────────┐
                    │          expedition-view.ts (NEW)        │
                    │   чистый модуль, без pi-tui/pi-coding    │
                    │                                          │
  chain.json ───────►  buildExpeditionView(chainDir, campDir) │
  state.json ───────►   → { ok } | { fail }                   │
  brief.json ───────►     ExpeditionView {                    │
  log.jsonl ────────►       map      (направления+статусы)    │
  evidence/ ────────►       timeline (события+обоснования)    │
                            questions (id, text, verdict,     │
                                       rule_id, reason)       │
                            evidence (файлы кампании)         │
                            counters (done/total, Q closed,   │
                                      campaigns, next action) │
                          }                                    │
                    │                                          │
                    │  toFullscreenLines(view, width) → string[]│
                    │  toWidgetVerdicts(view) → string|null    │
                    │  (HTML строит dashboard-web.ts — D4)     │
                    └──────┬──────────────┬──────────────┬─────┘
                           │              │              │
                  ┌────────▼─────┐ ┌──────▼───────┐ ┌────▼─────────┐
                  │ index.ts     │ │ index.ts     │ │ dashboard-   │
                  │ fullscreen   │ │ renderCall   │ │ web.ts       │
                  │ overlay      │ │ (research)   │ │ (HTML+JSON)  │
                  └──────────────┘ └──────────────┘ └──────────────┘
```

**Почему так:** виджет уже читает эти файлы (buildExpeditionWidgetLines, index.ts:303-350) —
но для fullscreen и web нужны БОЛЬШЕ данных (таймлайн с обоснованиями, вердикты, reason,
evidence). Дублировать файл-чтение в трёх местах — DRY-нарушение (урок S2-скаута).
Один ридер, три форматера. `expeditionWidgetLines` в expedition.ts остаётся как есть
(виджет-контракт зафиксирован спекой research-expedition; его регресс нельзя ломать),
верdicts-строку для виджета даёт новый `toWidgetVerdicts`.

**Fallback-иерархия ридера** (fail-soft на каждом шаге, вдохновлено buildExpeditionWidgetLines):

```
chain.json не читается/бит → view { fail: "journal" }  → все поверхности показывают
                                                          "(expedition: journal damaged)"
expedition_created нет     → view { fail: "not_expedition" }
направления: replayExpeditionMap (существующий)          → fail → "(map unavailable: …)"
кампания:    campaignDir null → campaign "none" (нет активной кампании + next-подсказка);
             каталог есть, state.json бит → campaign "unavailable", banner
             "(campaign data unavailable)"; вопросы/evidence в обоих случаях пусто
            (различие см. ниже, null-campaign vs unavailable)
вопросы:     brief.json бит → тексты = id; log.jsonl бит  → вердикты = пусто
evidence:    readdir fail → пусто (никогда не бросает)
```

Каждый шаг независим: битый log.jsonl не прячет карту, битый бриф не прячет таймлайн.

**null-campaign vs unavailable:** различие фиксируется в view: `campaign: "none"` (pin нет,
кампания не назначена — секция CAMPAIGN показывает строку «нет активной кампании; next:
активируйте направление/бриф следующей») и `campaign: "unavailable"` (каталог есть, но
state/brief/log не читаются — баннер «campaign data unavailable»). Тестовый кейс на оба.

## D2. Fullscreen expedition view

**Точка входа:** существующий `openFullscreenDashboard` (index.ts ~6962). Ветвление:

```
/autoresearch dashboard
        │
        ▼
   researchChain?.expedition === true?
        │yes                        │no
        ▼                           ▼
 buildExpeditionView()      [существующий путь без изменений]
        │                    state.results.length===0 → "No experiments yet"
   view.ok? ──no──► "(expedition: journal damaged)" полноэкранно
        │yes
        ▼
 ctx.ui.custom( render: toFullscreenLines(view, width) )
```

Клавиши/прокрутка/закрытие — наследуются от существующего overlay (ui.custom + overlay:true),
который уже умеет scrollOffset/viewportRows. Для экспедиции нужен только контент-билдер.
**Порядок секций** (сверху вниз, каждая с заголовком-лидером):

```
┌─ 🧭 Expedition — <цель> ─────────────────────────────────────────────┐
│                                                                       │
│  MAP                                                                  │
│   ✅ Tape multi-seed retry — refs exp…/Q1                    [refs]   │
│   🔄 Seed-ensemble expC — campaign exp…-c2 · Q3, Q4 open              │
│   ❓ Архитектура: attention/width/depth — самоотчёт, не доказательство│
│   💤 Новые aux-задачи — «ждём линзу»                                   │
│   ○ Классификатор атлас-таксономии — атлас как supervised-задача…     │
│   ○ Downstream на новых линзах — территория (b) владельца…            │
│                                                                       │
│  CAMPAIGN exp-1794452639286 (research) — вопросы                      │
│   Q1 ✓ confirmed  tape-rejected… — 5 сидов: <0.1930          [E]      │
│   Q2 ✗ rejected   ensemble-…   — ансамбль не дал…            [E]      │
│   Q3 · open      arch — attention поверх GRU…                         │
│   Q4 · open      atlas — …                                            │
│   Q5 · open      wave2 — …                                            │
│                                                                       │
│  EVIDENCE  tape_multiseed.py · tape_multiseed_eval.json · …           │
│                                                                       │
│  TIMELINE                                                             │
│   1  03:03  expedition_created — «Развитие модели-линзы expC…»        │
│   2  03:04  direction_opened «Tape multi-seed retry» — кэш ленты…     │
│   …    …    (всё с why/reason/note)                                   │
│                                                                       │
│  territory ██░░░░░░ 1/6 │ campaigns 2/7 │ Q 2/5 │ next: close→activate│
│                                                    [↑↓ scroll · Esc]  │
└───────────────────────────────────────────────────────────────────────┘
```

- Вердикт-глифы вопросов: `✓` confirmed, `✗` rejected, `?` inconclusive, `⏳` waiting_for_data,
  `·` открыт (правило вердикта — произвольная строка брифа, глиф выбирается по совпадению с
  DEFAULT_VERDICTS; неизвестный вердикт — `*`). Advisory-направление ВСЕГДА с пометкой
  «самоотчёт, не доказательство» (спека research-expedition).
- `[E]` — маркер evidence-файла; расшифровка секцией EVIDENCE ниже (имена файлов, клика нет —
  overlay текстовый).
- Таймлайн: до 200 последних событий, дальше «… N more»; каждое с `why`/`reason`/`note`
  (однострочная санитизация — существующий `oneLine` подход).
- Headless (`ctx.hasUI=false`): команда отвечает notify «нужен TUI» — как сейчас.

## D3. renderCall для expedition-действий

Сейчас `research` рисуется заголовком `research start|open|…` без содержимого. В renderCall
получаем `args` (action/subaction/dir/to/why/reason/refs) — их достаточно, файлы НЕ читать
(рендер вызывается до execute и часто; только args):

```
обычные действия:   research start · research status · research report  (как сейчас, только ярче лейбл)
expedition-действия:
  research expedition activate dir=«Seed-ensemble expC» why=«усреднение ≥3 сидов…»
      →  🔄 activate «Seed-ensemble expC»
         └ why: усреднение ≥3 сидов…
  research expedition resolve dir=«Tape multi-seed retry» refs=[exp…/Q1]
      →  ✅ resolve «Tape multi-seed retry» ← exp…/Q1
  research expedition park dir=«Новые aux-задачи» reason=«…»
      →  💤 park «Новые aux-задачи»
         └ reason: …
  research expedition pivot from=«A» to=«B» reason=«…»
      →  🔀 pivot «A» → «B»
         └ reason: …
```

- renderCall чистый: только `args`, без fs — регресс-безопасно.
- Неизвестные/битые args → существующий заголовок (fail-soft).
- Не-expedition-действия (`start/open/record/close/stop/status/report/resolve/chain_stop`) —
  лейбл с human-именем, содержимое не рисуется (параметров почти нет, кроме record: evidence_ref —
  рисуем его сокращённо).

## D4. Web-дашборд экспедиции

Существующий `exportDashboard` (index.ts:7336) жёстко читает `.auto/log.jsonl` и НЕ имеет
UI-гейта (в headless работает). Ветвление:

```
/autoresearch web
      │
      ▼
 активная экспедиция? (researchChain?.expedition || disk-scan как restore)
      │yes                          │no
      ▼                             ▼
 HEADLESS-ГЕЙТ (НОВОЕ, только     [существующий ledger-дашборд без изменений,
 в expedition-ветке):               включая отсутствие UI-гейта и текст
 ctx.hasUI === false → notify       ошибки «run some experiments first»]
 отказ «нужен TUI»; сервер
 НЕ поднимается
      │ hasUI
      ▼
 генерируется expedition.html   (карта + таймлайн + вопросы + счётчики)
      │
      ▼
 тот же static-server + openInBrowser, notify "Expedition dashboard at …"
```

- Владение кодом (уточнение D1): ветвление и endpoint — в index.ts рядом с
  exportDashboard; HTML-шаблон и клиентский JS — в НОВОМ dashboard-web.ts,
  экспортирующем buildExpeditionHtml(view). (Уточнение R2: диаграмма D1 обновлена — HTML-форматер
  принадлежит dashboard-web.ts, не expedition-view.ts.)
  HTML собирается в dashboard-web.ts из ExpeditionView.
- Обновление данных — ДВА пути, без новых broadcast-точек:
  (a) существующий SSE-сигнал «jsonl-updated» → страница делает fetch «/expedition»;
  (b) таймер опроса 10с → fetch «/expedition» (покрывает записи в chain.json /
  state.json / log.jsonl, у которых нет своей broadcast-точки).
  Endpoint: НОВЫЙ маршрут в resolveServedFile — «/expedition» отдаёт JSON
  (buildExpeditionView на лету, fail → JSON {fail:…}, страница показывает
  сообщение о повреждении).
- Повторный вызов — точный контракт существующего startStaticServer (проверено
  ревью против кода): тот же workDir → переиспользование сервера и URL (notify
  показывает прежний URL); другой workDir → замена: старый сервер закрывается,
  поднимается новый (notify показывает новый URL). Сценарий спеки фиксирует
  оба случая с наблюдаемым результатом — URL из notify.
- Страница read-only, слушает только 127.0.0.1.
- Нет активной экспедиции → прежний путь (включая ошибку «run some experiments first» —
  текст сохраняем, это контракт вне экспедиции).
- Headless в expedition-ветке: ЯВНЫЙ отказ (НОВОЕ поведение, сценарий спеки —
  «отказ; сервер не поднимается»); в не-expedition-ветке поведение НЕ меняется
  (гейт туда не добавляется — запись в Out of Scope proposal).

## D5. Вердикты в виджете

Футер существующей строки `Q closed/total` дополняется строкой вердиктов (только если
есть ≥1 закрытый вопрос):

```
обычно:                        с закрытыми:
  territory ██░░░░░░ 1/6 │       territory ██░░░░░░ 1/6 │ campaigns 2/7 │ Q 2/5
  campaigns 2/7 │ Q 2/5 │       Q: ✓tape ✗ens ✓arch ❓atlas ⏳wave
  next: …                        next: …
```

- Источник: log.jsonl close-события (question_id + verdict) + порядок вопросов из brief.json.
- Формат: `Q: <глиф><id>` подряд, id сокращаются до 4 символов при нехватке ширины
  (обрезка всей строки уже делает truncateToWidth).
- Глифы: `✓` confirmed · `✗` rejected · `❓` inconclusive · `⏳` waiting_for_data ·
  `*` прочее. Один关闭 вопрос без вердикта (битый лог) → без вердикт-глифа.
- Строка НЕ заменяет счётчик `Q n/m` — добавляется к нему (счётчик показывает прогресс,
  строка — состав).
- MODIFIED-статус: требование «Виджет карты» capability research-expedition НЕ переписывается —
  вердикт-строка идёт ОТДЕЛЬНЫМ ADDED-требованием «Вердикты вопросов в виджете карты» в delta
  этого change (совместимо с существующим футером: строка добавляется рядом со счётчиком).

## D6. Тестовая стратегия

- expedition-view.ts — юнит: fallback-иерархия (каждый битый файл отдельно), вердикт-глифы,
  сокращение id, порядок секций, advisory-пометка, лимит таймлайна, null-campaign (CAMPAIGN
  секция показывает «нет активной кампании» + next-подсказку) и unavailable (каталог есть,
  state.json бит — баннер «campaign data unavailable»): оба кейса раздельно.
- fullscreen — wiring: ветвление точки входа (экспедиция → view; обычный цикл → регресс),
  fail-отображение, headless-отказ, узкий терминал (минимальная ширина — строки обрезаются,
  overlay не падает).
- renderCall — юнит: все expedition-поддействия с человеческой строкой; не-expedition без
  изменения; битые args → заголовок.
- web — wiring: экспедиция → expedition.html + endpoint «/expedition» (JSON); вне экспедиции →
  ledger путь без гейта; headless в expedition-ветке → отказ; повторный вызов: тот же workDir →
  прежний URL в notify, другой workDir → новый URL; существующий SSE-механизм не сломан.
- виджет — существующие тесты + вердикт-строка (есть/нет/широкая/неизвестный вердикт).
- Серийный регресс: все research-expedition* + chain-briefs + charter-wiring + smoke.

## D7. Не-цели (дублируют proposal, для дизайн-полноты)

Tab-режимы виджета; waiting-акцент; валидация hash-цепочки в рендерах; новый state;
новые тулы; изменения экспортов headless.
