# Реализация research-campaign-switch (bd pi-autoresearch-zn4.1.2)

## Контекст
Спека заморожена (rv3 ГОДЕН, openspec validate 17/17). Владелец авторизовал реализацию.
Код: `extensions/pi-autoresearch/index.ts` (10645 строк), `research-state.ts` без изменений схемы.
Тесты: node --test, `--experimental-strip-types`, fake-pi harness (`tests/fake-pi.ts`).

## Декомпозиция — 3 независимых поля файлов, 3 волны

### Поле A: закрытие + replay (задачи 1.1, 2.1)
Файлы: `tests/research-stale-close.test.mjs` (новый), `extensions/pi-autoresearch/index.ts` — блоки:
- `replayResearchLog` (~8720-8768): событие `abandon` — валидно ровно один раз, только из
  фаз briefing/research (до него любое множество open/record/close/stop), после него ЛЮБОЕ
  событие (open/record/close/stop/abandon) → state_unreadable. Флаг `abandoned: boolean` в ResearchReplay.
- `closeStaleCampaign(dir)` — новая функция рядом с archiveFinishedCampaigns (~8580):
  1. `researchSnapshot(dir)` (отказ → не закрываемая);
  2. `updateState(dir, "abandon stale campaign", transition briefing|research→stopped, work)` где work:
     append `{event:"abandon", reason:"stale"}` + запись `report.md` через `researchState.writeFileAtomic`
     из фактического снапшота;
  3. Отчёт (машинный, без вердиктов): метка «closed as stale (not completed)», phase, id, время,
     бриф дословно (цель, вопросы с правилами, стоп-правила) — для одобренного брифа с разделами
     статусов вопросов (открытые = "not closed, no verdict") и «no stop rule triggered»;
     для briefing без одобренного брифа — только черновик брифа дословно, БЕЗ разделов вопросов/стопа.
- Тесты (все сценарии 1.1 + 2.1 из спеки: честное закрытие, pending-op, атомарность при сбое,
  повторное закрытие, abandon-после-stop, два abandon, событие после abandon).

### Поле B: guard запуска (задача 3.1)
Файлы: `tests/research-launch-guard.test.mjs` (новый), `extensions/pi-autoresearch/index.ts`:
- правка ветки `else if (existingIds.length > 0)` (~10453-10463): для каждой blocking-кампании —
  проверка закрываемости (D2): фаза briefing/research; НЕ pin этой сессии
  (`runtime.researchCampaignId !== id`); нет pending-op; state читается; не в `chainCampaignIds(ctx)`.
  Закрываемая → `closeStaleCampaign`; отказ любой → refusal с перечнем незакрываемых + причин.
  Все закрыты → продолжение запуска. Pin-ветка (~10474-10513) и `--id`-ветка не меняются.
- Тесты (сценарии спеки: stale research закрывается+архивируется draft'ом; смесь → отказ с перечнем;
  нечитаемый state → отказ; кампания цепочки → отказ; pin: без --id blocking-отказ, с --id другой
  кампании — pin-защита; нарушенный хеш брифа → brief_changed отказ; briefing закрывается —
  переписать регресс-тест 2.3 «refuses while a briefing campaign exists» в
  `research-exit-archive-fixes.test.mjs`).

### Поле C: nudges (задача 4.1)
Файлы: `tests/research-close-nudges.test.mjs` (новый), `extensions/pi-autoresearch/index.ts`:
- reply ветки `close` (~9819): после успешного закрытия — если все вопросы брифа закрыты и
  стоп не сработал → дописать «All questions are closed: pick a stop rule (research stop <rule_id>) then research report».
- `composeCampaignResumeMessage` (2625) — async, читает snapshot pinned-кампании:
  открытые вопросы → текущий текст; все закрыты + стопа нет → «close the campaign (stop + report)».
- `composeResearchDriftMessage` (2594) — параметризуется снапшотом/флагом; `composeDriftResumeMessage` (2640) awaits.
- `sendPendingResumeIfReady` (2451-2455): override затирает только legacy-цикловое сообщение
  (содержит run_experiment/log_experiment); state-aware сохранённый текст доставлять как есть.
- `notifyAutoResumeLimitReached` (2486) — при snapshot «все вопросы закрыты, фаза research» добавить
  «campaign <id> has all questions closed but is not finalized (needs stop + report)».
- fail-closed уже существует (pending-op/halted → отмена доставки, 2430-2433, 3253-3256) — тестами зафиксировать.

### Финальная фаза (оркестратор + ревьюер)
- Задача 5.1: docs/research-vectors.md раздел «Зависшие кампании: закрытие при запуске».
- 5.2: полный серийный прогон новых тестов + research-exit-archive-fixes + research-vectors набор +
  openspec validate --all; mark tasks.md checkboxes.
- 5.3: независимое опровергающее ревью свежим субагентом → ГОДЕН → точечный коммит → bd close.

## Порядок
1. Волна 1: A, B, C параллельно (поля не пересекаются внутри задач; index.ts — общий файл!).
   **Конфликт**: все три правят index.ts. Решение — работа в одном дереве по очереди? Нет:
   A, B, C правят РАЗНЫЕ области index.ts (8720-8768, 10453-10463, 2591-2519), но правки могут
   конфликтовать при одновременной записи. Разделение: воркер A правит только свою область,
   но правки B зависят от closeStaleCampaign (поле A). Зависимость B→A.
2. Учитывая зависимость B→A и общий файл index.ts:
   - Волна 1: A (closeStaleCampaign + replay + тесты A) и C (nudges + тесты C) параллельно —
     области index.ts не пересекаются (8.7k/9.8k vs 2.4-2.7k строки).
   - Волна 2: B (guard + тесты B) после A — вызывает closeStaleCampaign.
   - Волна 3: docs + serial run + mark tasks.
3. Ревью: по завершении каждого воркера — свежий ревьюер (опровергающий, сам гоняет тесты).
   Ревью B включает прогон регресса research-exit-archive-fixes.

## Гейты
- `node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-stale-close.test.mjs tests/research-launch-guard.test.mjs tests/research-close-nudges.test.mjs tests/research-exit-archive-fixes.test.mjs` (timeout 300)
- Полный `npm test` (serial) — перед коммитом.
- openspec validate --all.
