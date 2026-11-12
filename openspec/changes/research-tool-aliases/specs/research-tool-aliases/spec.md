# research-tool-aliases Specification

## ADDED Requirements

### Requirement: Отдельная регистрация фасадов

Расширение SHALL регистрировать два отдельных инструмента: `research_questions` для операций кампании и вопросов, и `expedition_map` для карты экспедиции.

#### Scenario: Оба инструмента объявлены модели
- **WHEN** расширение активно и объявляет инструменты
- **THEN** `research_questions` и `expedition_map` зарегистрированы как отдельные callable tools

### Requirement: Схема инструмента research_questions

`research_questions` SHALL предоставлять операции кампании и вопросов `start`, `open`, `record`, `close`, `stop`, `status`, `report`, `resolve`, `chain_stop` и соответствующие аргументы текущей схемы research. `resolve` здесь SHALL означать только operator-confirmed очистку pending-operation marker кампании.

#### Scenario: В схеме вопросов нет полей карты
- **WHEN** агенту объявляется schema инструмента `research_questions`
- **THEN** schema не содержит `refs`, `review_ref`, `review_sha256`, `from`, `to`

#### Scenario: Campaign resolve отличен от map resolve
- **WHEN** агент выбирает `research_questions(action="resolve")`
- **THEN** операция означает только операторское разрешение pending-op marker кампании и не означает закрытие направления карты

### Requirement: Схема инструмента expedition_map

`expedition_map` SHALL предоставлять map-only операции `open`, `activate`, `resolve`, `reject`, `advisory`, `park`, `reopen`, `pivot`, `status` через поле `subaction` и аргументы `dir`, `from`, `to`, `reason`, `why`, `refs`, `review_ref`, `review_sha256`.

#### Scenario: В схеме карты нет полей решения вопроса
- **WHEN** агенту объявляется schema инструмента `expedition_map`
- **THEN** schema не содержит `rule_id`, `verdict` и полей campaign-question close

#### Scenario: Map resolve отличен от campaign resolve
- **WHEN** агент вызывает `expedition_map(subaction="resolve")`
- **THEN** операция означает закрытие активного направления с refs и не означает операторское разрешение pending-op marker

### Requirement: Campaign facade delegates question operations

`research_questions` SHALL delegate question operations to the existing research executor; question transitions and journal logic are not duplicated.

#### Scenario: Вопрос кампании закрывается отдельным фасадом
- **WHEN** агент вызывает `research_questions` с action `close`, question_id, rule_id и verdict
- **THEN** вызов делегируется существующей логике `research close`; вопрос закрывается по прежним правилам

### Requirement: Map facade delegates direction operations

`expedition_map` SHALL delegate map operations to the existing expedition executor; map transition rules and journal effects are unchanged.

#### Scenario: Направление карты закрывается отдельным фасадом
- **WHEN** агент вызывает `expedition_map` с subaction `resolve` или `reject`, dir и refs
- **THEN** вызов делегируется существующей expedition map logic; операция требует тех же подтверждённых refs, что legacy-вызов

### Requirement: Facades preserve the execution-time mode gate

Both aliases SHALL preserve the execution-time mode gate of the existing gated research tools.

#### Scenario: Выключенный режим
- **WHEN** alias вызван при выключенном autoresearch mode
- **THEN** применяется тот же execution-time отказ, что у gated research tools

### Requirement: Campaign resolve требует операторского подтверждения

`research_questions(action="resolve")` SHALL требовать интерактивного UI и явного подтверждения оператора для pending operation. После подтверждения SHALL очищаться только pending-op marker кампании; карта не меняется и map transition в журнал не записывается.

#### Scenario: Подтверждение оператора
- **WHEN** alias resolve вызван для кампании с pending operation и оператор подтверждает диалог
- **THEN** очищается pending-op marker; map journal остаётся без новых transition entries

#### Scenario: Нет UI или отказ оператора
- **WHEN** alias resolve вызван без UI или оператор отказывает
- **THEN** действие отказывается, pending-op marker остаётся, map journal не меняется

### Requirement: Смешанный research tool не объявляется модели

Расширение SHALL NOT регистрировать combined `research` tool как callable tool. Его executor SHALL оставаться внутренним общим dispatcher, используемым aliases; внутренние action semantics, return/refusal codes, journal effects и execution-time mode gate не меняются. Прямые публичные вызовы старого tool должны мигрировать на новые aliases.

#### Scenario: Модель видит только раздельные фасады
- **WHEN** расширение регистрирует research/map tools
- **THEN** `research` отсутствует в публичном наборе, а `research_questions` и `expedition_map` присутствуют

#### Scenario: Новый фасад сохраняет прежние эффекты
- **WHEN** валидная операция выполняется через любой alias
- **THEN** вызывается прежняя внутренняя логика с теми же отказами/результатами и изменениями состояния

#### Scenario: Неправильные alias-поля дают направляющую ошибку
- **WHEN** вызов нового alias содержит поля другого фасада
- **THEN** вызов отклоняется без изменения состояния и указывает alias/action, принимающий эти поля

### Requirement: Model-facing instructions use public aliases

Все model-facing campaign instructions/notices SHALL использовать публичные aliases, не скрытый mixed `research`. Каждое действие SHALL задаваться отдельным допустимым `action`.

#### Scenario: Campaign resume и completion инструкции
- **WHEN** агенту приходит resume, compaction, completion, drift/pause, approval/start, stop/report или `/autoresearch research` kickoff сообщение
- **THEN** campaign calls адресованы `research_questions`, stop включает `rule_id` и `reason`, а примеры не используют union-like action values

### Requirement: Экспедиционные сообщения и widget hints используют aliases

Экспедиционные kickoff/restart/continuation сообщения и TUI next/divergence-подсказки SHALL использовать `expedition_map` для карты и `research_questions` для кампании/вопросов; новые сообщения SHALL NOT предписывать removed combined `research(action="expedition")`.

#### Scenario: Начало экспедиции
- **WHEN** агент получает kickoff после подтверждения документа экспедиции
- **THEN** инструкция предписывает активировать направление через `expedition_map` и вести вопросы кампании через `research_questions`

#### Scenario: Возобновление и продолжение
- **WHEN** экспедиция восстановлена после перезапуска или кампания завершена
- **THEN** сообщение использует новые aliases для следующего действия и не просит применять combined research tool

#### Scenario: Виджет подсказывает доступный alias
- **WHEN** TUI показывает next/divergence-подсказку для активной экспедиции
- **THEN** подсказка называет `expedition_map` для направления и `research_questions` для вопроса/кампании, а не скрытый combined tool

#### Scenario: Агент смешал поля закрытия
- **WHEN** агент передаёт `rule_id`/`verdict` в `expedition_map`
- **THEN** targeted refusal указывает на `research_questions(action="close")`; для закрытия направления указывает `expedition_map(subaction="resolve", refs=...)`
