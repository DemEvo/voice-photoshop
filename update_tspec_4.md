
---

# T-SPEC: RADIAL ABSOLUTE VOICE CONSTRUCTOR Pro mode

## 1. Ограничительная рамка (Core Restrictions & Boundary Conditions)

Спецификация фиксирует жесткие правила для реализации нового визуального движка и гибридной математики.
Изменения касаются **Pro mode**.

* **❌ STRICTLY FORBIDDEN:**
    * Использование библиотек `Canvas`, `SVG`, `D3.js` или `WebGL` для отрисовки радиальной диаграммы.
    * Изменение математики или структуры принимаемого JSON (относительные коэффициенты) на эндпоинте `/process`.
    * Вложенные циклы перерасчета UI-состояний во избежание бесконечных петель при обновлении DOM.
* **✅ EXPLICITLY ALLOWED:**
    * Реализация осей исключительно через элементы `<div>` и `<input type="range">`, спозиционированные через `transform: rotate(...)` и `transform-origin`.
    * Выполнение всех математических конвертаций (Абсолютное $\to$ Относительное) строго на стороне клиента (`app.js`).
    * Расширение эндпоинта `/upload` для приема `multipart/form-data` с двумя независимыми файлами.

---

## 2. Детерминированный поток (State Machine)

Бизнес-логика взаимодействия с гибридной радиальной системой.

1. `[Пользователь загрузил file_source и (опционально) file_reference]` -> `[Система (Backend) извлекла абсолютные метрики для одного/двух файлов]` -> `[Состояние: METRICS_EXTRACTED]`.
2. `[Система (Frontend) применила CSS-ротацию к 9 осям и контр-ротацию к текстовым меткам]` -> `[Система (Frontend) отрисовала параллельные треки Source и Reference]` -> `[Состояние: RADIAL_UI_READY]`.
3. `[Пользователь сдвинул ползунок (кноб) на оси Pitch к метке эталона (например, 150 Hz)]` -> `[Система (Frontend) рассчитала Ratio/Delta относительно базового значения file_source]` -> `[Состояние: MATH_CONVERTED]`.
4. `[Система (Frontend) отправила POST /process с относительными коэффициентами]` -> `[Система (Backend) вернула бинарный WAV]` -> `[Состояние: AUDIO_RENDERED]`.
5. `[Пользователь нажал Play на одном из двух плееров]` -> `[Система (Frontend) воспроизвела результат или эталон]` -> `[Состояние: PLAYBACK_ACTIVE]`.

---

## 3. Трансформация данных (Data Mutators & I/O)

Точная схема обмена данными и математики фронтенда.

**Изменение API `/upload` (Backend):**
Принимает `file_source` (обязательно) и `file_reference` (опционально). Возвращает два узла с абсолютными физическими значениями:
```json
{
  "source_metrics": { "pitch_hz": 100.0, "presence_db": 2.0 },
  "reference_metrics": { "pitch_hz": 150.0, "presence_db": 5.0 } 
}
```

**Математика конвертации (Frontend -> Backend `/process`):**
Расчет выполняется в момент отпускания кноба перед отправкой JSON на сервер.

* **Для частотных параметров (Pitch, F1, F2):** Используется коэффициент отношения (Ratio).
  $Ratio = \frac{Value_{target}}{Value_{source\_base}}$
  *(Пример: Юзер сдвинул Pitch на 150 Hz. Исходник был 100 Hz. Ratio = 1.5).*
* **Для амплитуд и порогов (Presence, Gate, De-Esser, Crest Factor):** Используется разница (Delta).
  $\Delta = Value_{target} - Value_{source\_base}$
  *(Пример: Юзер сдвинул Presence на 5 dB. Исходник был 2 dB. Отправляем +3 dB).*

---

## 4. Изоляция шума (Noise Reduction Parameters)

* **Single File Mode:** Если ключ `reference_metrics` в ответе сервера равен `null` или отсутствует, фронтенд принудительно устанавливает `display: none` для всех элементов, относящихся к треку эталона на радиальных осях, скрывая лишний визуальный шум.
* **Текстовая читаемость (Counter-Rotation):** CSS-свойство `transform: rotate(...)` текстовых узлов (значения Гц/дБ) должно рассчитываться по формуле $-1 \times AxisAngle$, чтобы метки всегда оставались строго горизонтальными и игнорировали поворот родительского контейнера-оси.

---

## 5. Обработка отказов (Fault Tolerance & Edge Cases)

Реакция системы на критические сбои при абсолютных вычислениях.

| Триггер сбоя | Ограничение / Условие | Точная реакция системы (Fallback) |
| :--- | :--- | :--- |
| **Деление на ноль** | $Value_{source\_base}$ для частоты равен 0 | Принудительная установка $Ratio = 1.0$ (bypass параметра). |
| **Выход за лимиты** | $Ratio$ частоты превышает диапазон [0.5, 2.0] | Жесткий Client-Side Clamping (срезка до 2.0 или 0.5) перед отправкой. |
| **Отсутствие Source** | Загружен только `file_reference` | Сервер возвращает `HTTP 400 Bad Request`. Текст: "Source file is mandatory". |
| **Поломка верстки** | Экстремальные пропорции экрана | Использование CSS-величин `vmin` для жесткого вписывания диаграммы без скролла. |

---

## 6. Ожидаемый артефакт (Final Deliverable)

Критерии приемки обновленной архитектуры.

* **Артефакт:** Обновленные файлы `main.py` (двойной парсинг), `index.html` (DOM-дерево из 9 осей) и `app.js` (логика ротации, контр-ротации и математика конвертации).
* **Тестовый прогон (DoD):**
    * Ввод [X]: `file_source` (Pitch = 100 Hz) и `file_reference` (Pitch = 150 Hz).
    * Ожидаемый UI [Y]: Радиальная диаграмма отрисовывается корректно. На оси "Pitch" (с лимитами `min="50" max="300"`) неподвижный маркер эталона стоит на отметке 150 Hz, активный кноб источника — на 100 Hz.
    * Ожидаемая логика [Z]: Пользователь тянет кноб источника к метке 150 Hz. JS вычисляет $Ratio = 1.5$ и отправляет валидный JSON на `/process`.

---

Ниже представлен **Пример** полностью рабочий, минималистичный и математически точный каркас для построения **одной радиальной «двойной оси»**. Вы сможете легко размножить этот HTML-блок 9 раз, просто меняя CSS-переменную `--angle`.

### HTML / CSS / JS Каркас (Radial UI)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    /* =========================================
       1. Глобальный контейнер диаграммы
       ========================================= */
    .radial-constructor {
        width: 600px;
        height: 600px;
        position: relative;
        background: #121212;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 50px auto;
        font-family: monospace;
        color: #fff;
    }

    /* Центральный хаб (для красоты и перекрытия стыков осей) */
    .center-hub {
        width: 60px;
        height: 60px;
        background: #2a2a2a;
        border-radius: 50%;
        z-index: 10;
        box-shadow: 0 0 20px rgba(0,0,0,0.8);
    }

    /* =========================================
       2. Магия Оси (Позиционирование из центра)
       ========================================= */
    .axis {
        position: absolute;
        left: 50%; /* Стартуем ровно из центра контейнера */
        top: 50%;
        width: 220px; /* Длина оси (радиус) */
        height: 40px;
        margin-top: -20px; /* Центрируем по вертикали относительно точки 50% */
        transform-origin: 0 50%; /* Точка вращения - левый край по центру */
        
        /* ГЛАВНЫЙ ХАК: Поворачиваем всю ось на заданный угол */
        transform: rotate(var(--angle));
        
        display: flex;
        align-items: center;
        z-index: 5;
    }

    /* =========================================
       3. Двойной трек (Source + Reference)
       ========================================= */
    .track-wrapper {
        position: relative;
        flex-grow: 1;
        margin: 0 15px;
        height: 20px;
        display: flex;
        align-items: center;
    }

    /* Трек Эталона (Reference Marker) - Неподвижная точка */
    .reference-marker {
        position: absolute;
        top: 50%;
        /* Позиция вычисляется в JS (от 0% до 100% ширины трека) */
        left: var(--ref-percent); 
        width: 12px;
        height: 12px;
        background-color: #ff3366; /* Акцентный цвет эталона */
        border-radius: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none; /* ВАЖНО: Клик проходит сквозь маркер к ползунку */
        z-index: 2;
        box-shadow: 0 0 10px rgba(255, 51, 102, 0.6);
    }

    /* Трек Источника (Source/Edit) - Стандартный input range */
    .source-slider {
        -webkit-appearance: none;
        width: 100%;
        background: rgba(255, 255, 255, 0.1);
        height: 4px;
        border-radius: 2px;
        outline: none;
        z-index: 3;
    }

    .source-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #4facfe;
        cursor: pointer;
        transition: transform 0.1s;
    }
    .source-slider::-webkit-slider-thumb:hover {
        transform: scale(1.3);
    }

    /* =========================================
       4. Контр-ротация текста (чтобы не был вверх ногами)
       ========================================= */
    .label-container {
        position: absolute;
        left: 230px; /* Выносим текст за пределы трека */
        
        /* ГЛАВНЫЙ ХАК 2: Вращаем текст в обратную сторону от оси */
        transform: rotate(calc(var(--angle) * -1));
        
        white-space: nowrap;
        text-align: center;
    }

    .label-title { font-size: 11px; color: #aaa; text-transform: uppercase; }
    .label-value { font-size: 14px; font-weight: bold; color: #4facfe; }

</style>
</head>
<body>

<div class="radial-constructor">
    <div class="center-hub"></div>

    <div class="axis" style="--angle: -25deg;">
        <div class="track-wrapper">
            <div class="reference-marker" id="ref-pitch" style="--ref-percent: 0%;"></div>
            
            <input type="range" class="source-slider" id="src-pitch" min="50" max="300" value="100" step="1">
        </div>
        
        <div class="label-container">
            <div class="label-title">Pitch</div>
            <div class="label-value"><span id="val-pitch">100</span> Hz</div>
        </div>
    </div>
    
    <div class="axis" style="--angle: 35deg;">
        <div class="track-wrapper">
            <div class="reference-marker" id="ref-presence" style="--ref-percent: 0%;"></div>
            <input type="range" class="source-slider" id="src-presence" min="0" max="10" value="2" step="0.1">
        </div>
        <div class="label-container">
            <div class="label-title">Presence</div>
            <div class="label-value"><span id="val-presence">2.0</span> dB</div>
        </div>
    </div>

</div>

<script>
    // =========================================
    // JS: Инициализация и маппинг физических данных
    // =========================================

    // Имитация ответа от бэкенда (POST /upload)
    const backendResponse = {
        source_metrics: { pitch_hz: 100.0, presence_db: 2.0 },
        reference_metrics: { pitch_hz: 175.0, presence_db: 8.0 }
    };

    /**
     * Переводит физическое значение (Гц, дБ) в проценты (0-100%) 
     * для корректного позиционирования красной точки (Эталона) на треке.
     */
    function calculatePercent(value, min, max) {
        let percent = ((value - min) / (max - min)) * 100;
        return Math.max(0, Math.min(100, percent)); // Clamping
    }

    // Инициализация при загрузке файлов
    function initRadialUI() {
        // --- Настройка оси Pitch ---
        const pitchSlider = document.getElementById('src-pitch');
        const pitchRefMarker = document.getElementById('ref-pitch');
        const pitchValDisplay = document.getElementById('val-pitch');
        
        // Ставим ползунок источника в его базовое положение
        pitchSlider.value = backendResponse.source_metrics.pitch_hz;
        pitchValDisplay.innerText = backendResponse.source_metrics.pitch_hz;
        
        // Высчитываем и ставим красную точку эталона
        const pitchRefPercent = calculatePercent(
            backendResponse.reference_metrics.pitch_hz, 
            pitchSlider.min, 
            pitchSlider.max
        );
        pitchRefMarker.style.setProperty('--ref-percent', `${pitchRefPercent}%`);

        // Динамическое обновление текста при движении ползунка
        pitchSlider.addEventListener('input', function() {
            pitchValDisplay.innerText = this.value;
        });

        // --- Настройка оси Presence (аналогично) ---
        const presSlider = document.getElementById('src-presence');
        const presRefMarker = document.getElementById('ref-presence');
        const presValDisplay = document.getElementById('val-presence');
        
        presSlider.value = backendResponse.source_metrics.presence_db;
        presValDisplay.innerText = backendResponse.source_metrics.presence_db.toFixed(1);
        
        const presRefPercent = calculatePercent(
            backendResponse.reference_metrics.presence_db, 
            presSlider.min, 
            presSlider.max
        );
        presRefMarker.style.setProperty('--ref-percent', `${presRefPercent}%`);

        presSlider.addEventListener('input', function() {
            presValDisplay.innerText = Number(this.value).toFixed(1);
        });
    }

    // Запускаем
    initRadialUI();
</script>
</body>
</html>
```

### 3 главных инженерных хака в этом коде:
1. **`transform-origin: 0 50%;` + `rotate(var(--angle))`**: Вся геометрия строится вокруг одной CSS-переменной. Вам не нужно считать синусы и косинусы для размещения осей. Просто распределите углы: $0^\circ, 40^\circ, 80^\circ$ и т.д.
2. **`transform: rotate(calc(var(--angle) * -1))` на тексте**: Нативный CSS-движок сам вычисляет обратный угол, чтобы цифры и метки всегда были параллельны горизонту монитора.
3. **`pointer-events: none;` на `reference-marker`**: Эталонная точка лежит *поверх* ползунка, но из-за этого свойства мышка кликает «сквозь» нее. Пользователь может перетянуть свой ползунок ровно в позицию эталона без визуальных багов.

---

Это **Пример** фрагмент клиентской логики, который замыкает цикл: он забирает данные из красивого радиального интерфейса, прогоняет их через математику дельт и коэффициентов, и формирует тот самый JSON, который ожидает сервер. 

Сервер при этом остается в полном неведении, что интерфейс изменился — он продолжает получать привычные ему `pitch_ratio` и `presence_db`.

Ниже представлен **Пример** JS-код конвертера, который нужно добавить в файл `app.js` (сразу после функции `initRadialUI`).

### Имплементация логики конвертации (app.js)

```javascript
    /**
     * T-SPEC COMPLIANT: ABSOLUTE TO RELATIVE CONVERTER
     * Собирает абсолютные значения с радиальных осей, вычисляет Ratio и Delta
     * относительно базовых метрик источника и формирует JSON для сервера.
     */
    function generateProcessPayload() {
        // 1. Получаем базовые метрики источника (сохраненные при загрузке)
        // Защита: если данных нет, используем безопасные fallback-значения
        const base = backendResponse.source_metrics || {
            pitch_hz: 100.0,
            f1_hz: 500.0,
            f2_hz: 1500.0,
            presence_db: 2.0,
            noise_floor_db: -45.0,
            sibilance_peak_db: -10.0
        };

        // 2. Считываем ТЕКУЩИЕ абсолютные значения с ползунков UI
        // В реальном коде здесь считываются все 9 input-элементов
        const currentPitchHz = parseFloat(document.getElementById('src-pitch').value);
        const currentPresenceDb = parseFloat(document.getElementById('src-presence').value);
        
        // (Мокируем остальные значения для примера сборки полного payload)
        const currentF1Hz = base.f1_hz; 
        const currentF2Hz = base.f2_hz;
        const currentGateDb = base.noise_floor_db;
        const currentDeEsserDb = base.sibilance_peak_db;

        // ==========================================
        // 3. МАТЕМАТИКА ФРОНТЕНДА (Client-Side Math)
        // ==========================================

        // А. Расчет частот (Ratio)
        // Edge Case: Защита от деления на ноль, если базовый F0 не определился (глухой звук)
        let pitchRatio = base.pitch_hz > 0 ? (currentPitchHz / base.pitch_hz) : 1.0;
        let formantRatio = base.f1_hz > 0 ? (currentF1Hz / base.f1_hz) : 1.0;

        // Жесткое ограничение (Clamping) для защиты бэкенда от экстремальных значений
        pitchRatio = Math.max(0.5, Math.min(2.0, pitchRatio));
        formantRatio = Math.max(0.7, Math.min(1.3, formantRatio));

        // Б. Расчет амплитуд (Delta / Абсолютные сдвиги)
        let presenceDelta = currentPresenceDb - base.presence_db;
        let f2ShiftDelta = currentF2Hz - base.f2_hz;
        
        // Для шумоподавления и де-эссера вычисляем, насколько агрессивно нужно давить звук
        // Например: если пик сибилянтов -10 дБ, а мы хотим -20 дБ, дельта равна 10 дБ подавления
        let deesserAmount = base.sibilance_peak_db - currentDeEsserDb; 
        deesserAmount = Math.max(0.0, Math.min(100.0, deesserAmount * 5)); // Маппинг в проценты (0-100)

        // ==========================================
        // 4. СБОРКА ИТОГОВОГО JSON PAYLOAD
        // ==========================================
        
        const payload = {
            basic: {
                pitch_ratio: Number(pitchRatio.toFixed(3)),
                formant_ratio: Number(formantRatio.toFixed(3)),
                presence_db: Number(presenceDelta.toFixed(1)),
                compression: 50.0 // Статично для примера (в реальности считается из Crest Factor)
            },
            advanced: {
                f1_shift: 0.0, // Заблокировано спецификацией для сохранения тембра
                f2_shift: Number(f2ShiftDelta.toFixed(1)),
                jitter_mod: 0.0, // Считается аналогично через Delta
                breathiness_mod: 0.0, // Считается аналогично через Delta
                noise_gate_db: Number(currentGateDb.toFixed(1)), // Отправляем абсолютный порог
                deesser_amount: Number(deesserAmount.toFixed(1))
            }
        };

        return payload;
    }

    // ==========================================
    // Пример привязки к событию:
    // ==========================================
    let renderTimer;

    // Вешаем слушатель на все ползунки с классом .source-slider
    document.querySelectorAll('.source-slider').forEach(slider => {
        slider.addEventListener('change', () => {
            // Изоляция шума: не отправляем запрос на каждое микро-движение (Debounce 300ms)
            clearTimeout(renderTimer);
            renderTimer = setTimeout(() => {
                const finalJson = generateProcessPayload();
                console.log("Отправка на /process:", JSON.stringify(finalJson, null, 2));
                
                // Здесь будет ваш fetch('/process', { method: 'POST', body: JSON.stringify(finalJson) })
            }, 300);
        });
    });
```

### Что делает этот код надежным:
* **Защита от нулевого знаменателя:** Если исходный аудиофайл содержит сплошную тишину (или это просто шум без основного тона), `base.pitch_hz` будет равно `0`. Алгоритм мягко переведет `Ratio` в `1.0`, спасая бэкенд от падения с ошибкой `ZeroDivisionError`.
* **Client-Side Clamping:** Функция `Math.max` и `Math.min` жестко удерживает коэффициенты в дозволенных физических рамках, даже если пользователь попытается сломать ползунок через DevTools браузера.
* **Debouncing:** Использование `setTimeout` на `change` предотвращает DDoS-атаку на локальный сервер при быстром перетаскивании ползунков.

---
