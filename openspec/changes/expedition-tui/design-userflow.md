# expedition-tui — Полная карта пользовательских потоков и изменений поверхностей

Этот документ показывает, ЧТО видит владелец на каждой поверхности ДО и ПОСЛЕ, и по каким
путям ходят данные. Всё — read-only отображение существующих файлов; семантика экспедиции
не меняется.

---

## 1. Поверхности: где что показывается

```
СУЩЕСТВУЮЩИЕ ПОВЕРХНОСТИ                 ПОСЛЕ expedition-tui
──────────────────────────────           ──────────────────────────────────
Виджет (всегда на экране)        →       + строка вердиктов вопросов     [D5]
/autoresearch dashboard          →       + fullscreen-карта экспедиции   [D2]
  (fullscreen overlay)                     (сейчас: "No experiments yet")
Транскрипт тулов (скролл)        →       + renderCall expedition-действий[D3]
/autoresearch web (браузер)      →       + expedition-страница           [D4]
  (ledger обычного цикла)                  (сейчас: пустой ledger-дашборд)
expedition-report.md             →       без изменений (финал цепочки)
research report / status         →       без изменений
```

---

## 2. Userflow: владелец открывает fullscreen

```
 Владелец                      TUI                              Файлы
 ─────────                     ───                              ─────
 нажимает /autoresearch
 dashboard ────────────────►  ветвление: researchChain.expedition?
                                    │ yes                      chain.json ──┐
                              buildExpeditionView()  ◄──────── state.json ──┤
                                    │                          brief.json ──┤
                              view собран (fail-soft)          log.jsonl ───┤
                                    │                          evidence/ ───┘
                              toFullscreenLines(view, width)
                                    │
                              ctx.ui.custom(overlay)  ◄─── клавиши как у
                                    │                          существующего
        ◄─────── карта целиком ─────┘                          overlay (↑↓, Esc)
 скроллит таймлайн, читает
 вердикты и evidence
 Esc → закрыл
```

### Что увидит владелец (полный экран, данные живой экспедиции lob-collector-data)

```
┌─ 🧭 Expedition — Развитие модели-«линзы» expC (fresh R² 0.1780) ─────┐
│                                                                       │
│ MAP                                                                   │
│  ○ Tape multi-seed retry — кэш ленты готов; +1.07пп был в шуме…      │
│  ○ Seed-ensemble expC — усреднение ≥3 сидов; никогда не пробовали…   │
│  ○ Архитектура: attention/width/depth — главный источник прироста…   │
│  ○ Новые aux-задачи — режим волатильности, спред, «большой ход»…     │
│  ○ Классификатор атлас-таксономии — атлас как supervised-задача…     │
│  ○ Downstream на новых линзах — территория (b) владельца…            │
│                                                                       │
│ CAMPAIGN exp-1794452639286 (research)                                 │
│  Q1 ✓ confirmed  tape-confirmed  — лента ≥3 сидов дала +1.9пп…       │
│  Q2 ✗ rejected   ensemble-rejected — ансамбль не превзошёл…          │
│  Q3 ✗ rejected   arch-rejected    — attention не дал…                │
│  Q4 · open       atlas            — кластеризация атласа…            │
│  Q5 · open       wave2            — aux-задачи…                      │
│                                                                       │
│ EVIDENCE  tape_multiseed.py · tape_multiseed_eval.json · …           │
│                                                                       │
│ TIMELINE                                                              │
│  1  03:03  expedition_created — «Развитие модели-линзы…»             │
│  2  03:04  direction_opened «Tape multi-seed retry» — кэш ленты…     │
│  …                                                                    │
│                                                                       │
│ territory ░░░░░░░░░░ 0/6 │ campaigns 1/7 │ Q 2/5 │ next: activate    │
│                                              [↑↓ scroll · Esc close] │
└───────────────────────────────────────────────────────────────────────┘
```

Сценарий «битый журнал»: `chain.json` повреждён → полноэкранно одна строка
`(expedition: journal damaged)` — никакого краша, никакого пустого экрана.

---

## 3. Userflow: агент работает — владелец читает транскрипт

```
Агент вызывает                          Транскрипт ДО              ПОСЛЕ [D3]
─────────────────                       ─────────────              ──────────
research expedition activate            research expedition        🔄 activate «Seed-ensemble expC»
  dir="Seed-ensemble expC"                activate                 └ why: усреднение ≥3 сидов…
  why="усреднение ≥3 сидов…"
research expedition resolve             research expedition        ✅ resolve «Tape multi-seed retry»
  dir="Tape multi-seed retry"             resolve                    ← exp…/Q1
  refs=[{campaign:"exp…",question:"Q1"}]
research expedition pivot               research expedition        🔀 pivot «A» → «B»
  from="A" to="B" reason="…"              pivot                     └ reason: …
research status                         research status            research status (лейбл ярче,
                                                                   содержимого нет — не меняется)
```

renderCall читает ТОЛЬКО args (без fs) — вызывается до execute, дёшево, регресс-безопасно.

---

## 4. Userflow: браузерный дашборд

```
Владелец: /autoresearch web
        │
        ▼
 экспедиция активна? ───no──► ledger-дашборд как сейчас (регресс не допускается)
        │ yes
        ▼
 expedition.html сгенерирован, static-server поднят (существующий),
 браузер открыт, notify "Expedition dashboard at http://127.0.0.1:…"
        │
        ▼
 страница обновляет данные: SSE «jsonl-updated» + опрос 10с → fetch /expedition ─── тот же сервер
        │                                                    (новых серверов нет)
        ▼
 ┌─ Браузер ─────────────────────────────────────────────┐
 │ 🧭 Развитие модели-«линзы» expC                        │
 │                                                        │
 │ MAP (6 направлений, глифы, основания)                  │
 │ CAMPAIGN … (вопросы с вердиктами и reason)             │
 │ EVIDENCE (файлы кампании)                              │
 │ TIMELINE (события с why/reason)                        │
 │ territory 0/6 · campaigns 1/7 · Q 2/5 · next: activate│
 └────────────────────────────────────────────────────────┘
```

---

## 5. Userflow: виджет — вердикты вопросов

```
ДО (сейчас):                             ПОСЛЕ [D5]:
…                                        …
territory ░░░░░░░░░░ 0/6 │               territory ░░░░░░░░░░ 0/6 │
campaigns 1/7 │ Q 2/5 │                  campaigns 1/7 │ Q 2/5 │
next: activate                           Q: ✓Q1 ✗Q2 ✗Q3
                                         next: activate
```

- нет закрытых вопросов → строки `Q:` нет (футер как сейчас);
- неизвестный вердикт (произвольная строка брифа) → глиф `*`;
- ширины не хватает → вся строка обрезается существующим truncateToWidth.

---

## 6. Поток данных по всем поверхностям

```
                    ┌──────────── все поверхности читают ТОЛЬКО ЭТИ ФАЙЛЫ ───────────┐
                    │                                                                 │
 .auto/research-chain/<id>-chain/chain.json      ── карта, таймлайн, счётчики цепочки│
 .auto/research-chain/<id>-chain/expedition.json ── маркер рестарта (goal, charter)  │
 .auto/research/<campaign>/state.json            ── фаза кампании                    │
 .auto/research/<campaign>/brief.json            ── вопросы (id → текст, порядок)    │
 .auto/research/<campaign>/log.jsonl             ── open/close события, вердикты     │
 .auto/research/<campaign>/evidence/*            ── имена файлов evidence            │
                    │                                                                 │
                    └─── expedition-view.ts buildExpeditionView() → ExpeditionView ───┘
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              ▼                               ▼                               ▼
     toFullscreenLines()            dashboard-web.ts:           toWidgetVerdicts()
     fullscreen overlay             buildExpeditionHtml(view)    виджет футер [D5]
     [D2]                           [D4]                          (карта/таймлайн —
     renderCall(args) без fs        expedition.html               без изменений)
     [D3]                           [D4]
```

## 7. Что НЕ меняется (границы)

- Спека research-expedition: точка входа, документ, подтверждение, карта, переходы,
  доказанности, срез в продолжении, предикат, отчёт — без изменений.
- Виджет-карта (заголовок/строки направлений/счётчики) — без изменений, только +1 строка.
- Ledger-дашборд вне экспедиции — байт-в-байт прежний путь (включая текст ошибки).
- Headless-поведение: НОВОЕ — web-команда при активной экспедиции отказывает без UI (гейт только
  в expedition-ветке, см. D4); вне экспедиции поведение прежнее (гейта нет, как сейчас);
  fullscreen при экспедиции в headless также отказывает (там гейт существовал).
- Семантика research/expedition-тулов, переходов, журнала — не трогается.
```
