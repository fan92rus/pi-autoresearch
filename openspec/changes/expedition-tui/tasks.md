# Tasks: expedition-tui

Зависимости: 1 → (2, 4, 5); 3 независимо; 4 зависит от 1 (использует ExpeditionView);
6, 7 — в конце. Группа 4 включает уточнённый контракт обновления из ревью R1.

## 1. Чистый ридер expedition-view.ts
- [ ] 1.1 Модуль `expedition-view.ts`: `buildExpeditionView(chainDir, campaignDir|null)` → ExpeditionView с секциями map/timeline/questions/evidence/counters; fallback-иерархия design.md D1 (независимые try на каждый файл; journal fail → view.fail)
- [ ] 1.2 Форматер `toFullscreenLines(view, width)` — секции в порядке D2, advisory-пометка, лимит таймлайна 200 + «… N more», однострочная санитизация, узкий терминал (обрезка без падения)
- [ ] 1.3 Форматер `toWidgetVerdicts(view)` — строка `Q: <глиф><id>` или null; глифы ✓✗❓⏳*
- [ ] 1.4 Юнит-тесты ридера: каждый файл бит по отдельности; вердикт-глифы; порядок вопросов из брифа; advisory; лимит; сокращение id; null-campaign («нет активной кампании» + next) vs unavailable («campaign data unavailable») — оба кейса

## 2. Fullscreen expedition view
- [ ] 2.1 Ветвление `openFullscreenDashboard`: expedition → buildExpeditionView + overlay через toFullscreenLines; вне экспедиции — прежний путь без изменений; headless-отказ сохранён
- [ ] 2.2 Wiring-тесты: активная экспедиция → overlay с секциями (перехват ui.custom); битый журнал → сообщение о повреждении; null-campaign → CAMPAIGN-баннер; обычный цикл (есть результаты/нет результатов) — регресс существующих уведомлений; узкий терминал — обрезка без падения

## 3. renderCall expedition-действий
- [ ] 3.1 renderCall для `research`: expedition-поддействия (activate/resolve/reject/advisory/park/reopen/pivot) — глиф + имя + why/reason/refs из args, без fs; не-expedition — прежний заголовок; битые args — заголовок
- [ ] 3.2 Юнит-тесты: все поддействия; не-expedition регресс; битые args

## 4. Web-дашборд экспедиции
- [ ] 4.1 Ветвление `exportDashboard`: активная экспедиция + ctx.hasUI → expedition.html (карта+таймлайн+вопросы+счётчики, buildExpeditionHtml в новом dashboard-web.ts); НОВЫЙ headless-гейт ТОЛЬКО в expedition-ветке (notify-отказ, сервер не поднимается); вне экспедиции — прежний путь без изменений (включая отсутствие гейта и текст ошибки); повторный вызов — контракт существующего сервера (тот же workDir → прежний URL; другой → замена, новый URL)
- [ ] 4.2 Маршрут «/expedition» в resolveServedFile: JSON текущего view на лету (fail → JSON с признаком повреждения); страница обновляет данные двумя путями без новых broadcast-точек: существующий SSE-сигнал «jsonl-updated» + таймер опроса 10с
- [ ] 4.3 Wiring-тесты: экспедиция+TUI → страница+endpoint отдаёт view; headless в экспедиции → отказ без сервера; вне экспедиции → регресс прежнего пути; повторный вызов (тот же/другой workDir → прежний/новый URL в notify); существующий SSE-механизм не сломан (регресс existing web-тестов)

## 5. Вердикты в виджете
- [ ] 5.1 buildExpeditionWidgetLines: строка toWidgetVerdicts в футер (после счётчика Q, перед next); без закрытых — без строки; fail-soft
- [ ] 5.2 Виджет-тесты: есть закрытые → строка есть и в порядке брифа; нет закрытых — нет строки; неизвестный вердикт → `*`; существующие виджет-тесты зелёные

## 6. Документация и валидация
- [ ] 6.1 docs/research-vectors.md: раздел «TUI-поверхности экспедиции» (fullscreen, web, renderCall, вердикты) — 10-15 строк
- [ ] 6.2 openspec validate --all зелёный

## 7. Регресс и приёмка
- [ ] 7.1 Серийный регресс: все research-expedition* тесты + chain-briefs + charter-wiring + launch-guard + smoke — зелёные
- [ ] 7.2 Независимое adversarial-ревью до ГОДЕН (fresh-агент, попытка сломать: битые файлы, длинные строки, вне-экспедиционный регресс, headless)
- [ ] 7.3 Коммит + bd close
