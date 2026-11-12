# Change: Разделить инструменты исследования на явные фасады

## Why

Во время экспедиции в `lob-collector-data` агент трижды вызвал `research` с `action="expedition"`, но приложил `rule_id` и `verdict` — поля закрытия вопроса кампании. Валидатор верно отказал, но существующая схема одного широкого тула объединяет две разные области: операции вопросов кампании и переходы карты экспедиции.

## What changes

1. Добавить `expedition_map` — отдельный фасад с map-only схемой, без полей `rule_id`/`verdict`; действия карты — `open/activate/resolve/reject/advisory/park/reopen/pivot/status`.
2. Добавить `research_questions` — фасад кампании: старт/открытие/запись/закрытие вопросов, остановка, статус, отчёт и операторское разрешение pending operation.
3. Фасады проксируют существующий dispatcher `research`; карта/журнал/валидация не дублируются.
4. Сохранить `research` как обратносуместимый legacy-интерфейс, пометить его как legacy в description, направить агента к новым фасадам.
5. Обновить kickoff, restart-resume и continuation-сообщения: вопросы/кампания через `research_questions`, карта через `expedition_map`.

## User flow

```
До:
  research(action="expedition", subaction="resolve", dir=..., rule_id=..., verdict=...)
  └─ одна широкая схема → модель смешивает поля разных поддействий → invalid_argument

После:
  research_questions(action="close", question_id=..., rule_id=..., verdict=...)
       └─ закрывает ВОПРОС в кампании
  expedition_map(subaction="resolve", dir=..., refs=[{campaign, question}], reason=...)
       └─ закрывает НАПРАВЛЕНИЕ на карте, ссылаясь на закрытые вопросы

  research(...) остаётся доступен как legacy для старых скриптов/сессий.
```

## Non-goals

- Не менять формат журнала, переходы карты, валидаторы и смысл действий.
- Не скрывать глобальные/core tools и не менять active tool set/cache.
- Не удалять старый `research` tool и не ломать headless JSON-RPC контракт.
- Не вводить полный рефакторинг executor — только тонкие алиасы поверх него.
