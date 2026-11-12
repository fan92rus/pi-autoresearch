# Change: Разделить инструменты исследования на явные фасады

## Why

Во время экспедиции в `lob-collector-data` агент трижды вызвал `research` с `action="expedition"`, но приложил `rule_id` и `verdict` — поля закрытия вопроса кампании. Валидатор верно отказал, но существующая схема одного широкого тула объединяет две разные области: операции вопросов кампании и переходы карты экспедиции.

## What changes

1. Добавить `expedition_map` — отдельный фасад с map-only схемой, без полей `rule_id`/`verdict`; действия карты — `open/activate/resolve/reject/advisory/park/reopen/pivot/status`.
2. Добавить `research_questions` — фасад кампании: старт/открытие/запись/закрытие вопросов, остановка, статус, отчёт и операторское разрешение pending operation.
3. Фасады проксируют существующий dispatcher `research`; карта/журнал/валидация не дублируются.
4. Убрать combined tool `research` из публичной регистрации, чтобы модель не видела смешанную схему. Его executor остаётся внутренней общей реализацией за aliases — без дублирования логики.
5. Обновить все model-facing campaign instructions/notices (kickoff, restart/resume, compaction/completion, drift/pause, approval/start, stop/report) и видимые widget hints: вопросы/кампания через `research_questions`, карта через `expedition_map`.

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

  внутренний executor сохраняет прежние операции; публично старого combined tool нет.
```

## Non-goals

- Не менять формат журнала, переходы карты, валидаторы и смысл действий.
- Не скрывать глобальные/core tools и не менять active tool set/cache.
- Не вырезать внутреннюю реализацию research executor: оба aliases продолжают делегировать ему. Прямые старые вызовы публичного tool `research` прекращают работать; новые calls используют aliases.
- Не вводить полный рефакторинг executor — только тонкие алиасы поверх него.
