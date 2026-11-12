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

### Requirement: Фасады делегируют существующей логике

Вызовы обоих новых фасадов SHALL делегироваться существующему research executor без копирования переходов или journal logic; сохраняются прежние execution-time mode gate, валидация, коды отказов и записи журнала.

#### Scenario: Вопрос кампании закрывается отдельным фасадом
- **WHEN** агент вызывает `research_questions` с action `close`, question_id, rule_id и verdict
- **THEN** вызов делегируется существующей логике `research close`; вопрос закрывается по прежним правилам

#### Scenario: Направление карты закрывается отдельным фасадом
- **WHEN** агент вызывает `expedition_map` с subaction `resolve` или `reject`, dir и refs
- **THEN** вызов делегируется существующей expedition map logic; операция требует тех же подтверждённых refs, что legacy-вызов

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

### Requirement: Совместимость legacy research

Существующий инструмент `research` SHALL оставаться зарегистрированным с прежней схемой и поведением для старых клиентов и сессий. Его описание SHALL называть его legacy-совместимым фасадом и рекомендовать новые инструменты для новых model calls.

#### Scenario: Legacy-вызовы остаются рабочими
- **WHEN** существующий клиент вызывает старый `research` tool с валидным аргументом
- **THEN** прежняя схема, результат и поведение сохраняются

#### Scenario: Неправильные alias-поля дают направляющую ошибку
- **WHEN** вызов нового alias содержит поля другого фасада
- **THEN** вызов отклоняется без изменения состояния и указывает alias/action, принимающий эти поля

### Requirement: Экспедиционные сообщения используют новые aliases

Экспедиционные kickoff-, restart-resume- и continuation-инструкции, адресованные агенту, SHALL использовать `expedition_map` для карты и `research_questions` для кампании/вопросов; объясняется различие: `research_questions(action="close")` закрывает вопрос, `expedition_map(subaction="resolve"|"reject")` закрывает направление через refs. Инструкции SHALL NOT предписывать новые вызовы legacy `research(action="expedition")`.

#### Scenario: Начало экспедиции
- **WHEN** агент получает kickoff после подтверждения документа экспедиции
- **THEN** инструкция предписывает активировать направление через `expedition_map` и вести вопросы кампании через `research_questions`

#### Scenario: Возобновление и продолжение
- **WHEN** экспедиция восстановлена после перезапуска или кампания завершена
- **THEN** сообщение использует новые aliases для следующего действия и не просит применять legacy expedition subaction на `research`

#### Scenario: Агент смешал поля закрытия
- **WHEN** агент передаёт `rule_id`/`verdict` в `expedition_map`
- **THEN** targeted refusal указывает на `research_questions(action="close")`; для закрытия направления указывает `expedition_map(subaction="resolve", refs=...)`
