---

# T-SPEC: PERCEPTUAL MACRO-CONTROLS (UI ABSTRACTION LAYER)

## 1. Ограничительная рамка (Core Restrictions & Boundary Conditions)

В этом разделе зафиксированы жесткие границы внедрения абстрактного слоя: архитектура сервера остается «слепой» к изменениям UI.

* **❌ STRICTLY FORBIDDEN:**
    * Любые модификации файла `main.py` и логики обработки на стороне сервера (Zero Backend Changes).
    * Использование двусторонней привязки данных (Two-Way Data Binding) между простым и продвинутым режимами (чтобы избежать математических петель обратного расчета).
    * Отправка новых (не задокументированных ранее) ключей в JSON-запросе.
* **✅ EXPLICITLY ALLOWED:**
    * Выполнение всех математических преобразований (PCA Mapping) исключительно средствами JavaScript (`app.js`).
    * Принудительное ограничение значений (Client-Side Clamping) перед формированием Payload.
    * Изменение DOM-дерева (`index.html`) для реализации глобального переключателя режимов (Simple / Pro).

---

## 2. Детерминированный поток (State Machine / User Flow)

Логика синхронизации состояний интерфейса и однонаправленного потока данных.

1. **[Пользователь: Открывает приложение]** -> `[Система: Инициализирует UI с активным Simple Mode]` -> `[Состояние: UI_MODE_SIMPLE]`.
    * *Примечание:* 3 макро-слайдера видимы, 10 инженерных слайдеров скрыты (CSS `display: none`).
2. **[Пользователь: Двигает макро-слайдер (например, Clarity)]** -> `[Система (app.js): Рассчитывает матрицу маппинга и физически обновляет значения скрытых Pro-слайдеров]` -> `[Состояние: MACRO_SYNCED]`.
3. **[Система: Срабатывает Debounce]** -> `[Система (app.js): Собирает JSON из скрытых Pro-слайдеров и отправляет POST /process_audio]` -> `[Состояние: PROCESSING]`.
4. **[Пользователь: Нажимает Toggle "Pro Mode"]** -> `[Система: Скрывает макро-слайдеры, отображает 10 инженерных панелей]` -> `[Состояние: UI_MODE_PRO]`.
5. **[Пользователь: Изменяет любой Pro-слайдер вручную]** -> `[Система (app.js): Разрывает связь (сбрасывает макро-слайдеры в Null/Default)]` -> `[Состояние: MACRO_DISCONNECTED]`.

---

## 3. Трансформация данных (PCA Mapping Matrix & Clamping)

Формулы конвертации потребительских осей (Macro) в инженерные параметры (Micro) для скрипта `app.js`.

### Базовые переменные (Inputs):
* $C$ — Clarity (Разборчивость). Диапазон: $[0, 100]$
* $W$ — Warmth (Бархат). Диапазон: $[0, 100]$
* $A$ — Vocal Age (Износ связок). Диапазон: $[-100, 100]$

### Матрица преобразований (Outputs):

**Ось 1: Clarity (Разборчивость)**
Влияет на высокочастотную детализацию.
* `f2_shift` = $\min(200.0, C \times 2.0)$
* `presence_db` = $\min(6.0, C \times 0.06)$
* `deesser_amount` = $\min(50.0, C \times 0.5)$

**Ось 2: Warmth (Бархат)**
Увеличивает массу тела и выравнивает динамику.
* `formant_ratio` = $\max(0.85, 1.0 - (W \times 0.0015))$
* `pitch_ratio` = $\max(0.95, 1.0 - (W \times 0.0005))$
* `compression_level` = $\min(80.0, 50.0 + (W \times 0.3))$
* `noise_gate_db` = $\min(-50.0, -60.0 + (W \times 0.1))$

**Ось 3: Vocal Age (Износ связок)**
Добавляет физиологические артефакты (сип, дрожание).
* `jitter_mod` = $\max(-1.0, \min(1.0, A \times 0.01))$
* `breathiness_mod` = $$\begin{cases} \min(60.0, A \times 0.6), & \text{если } A > 0 \\ 0.0, & \text{если } A \le 0 \end{cases}$$

*(Остальные параметры из 10 базовых остаются на значениях по умолчанию, если не затронуты матрицей).*

---

## 4. Спецификация Payload (Data I/O)

Пример валидного JSON-объекта, который `app.js` должен сгенерировать после применения макро-маппинга (например, при $C=100$, $W=100$, $A=50$) и жесткого Client-Side Clamping. Бэкенд получает структуру, идентичную Pro-режиму.

```json
{
  "basic": {
    "pitch_ratio": 0.95,
    "formant_ratio": 0.85,
    "presence_db": 6.0,
    "compression": 80.0
  },
  "advanced": {
    "f1_shift": 0.0,
    "f2_shift": 200.0,
    "jitter_mod": 0.5,
    "breathiness_mod": 30.0,
    "noise_gate_db": -50.0,
    "deesser_amount": 50.0
  }
}
```

---

## 5. Изоляция шума (Noise Reduction Parameters)

* **Debouncing UI-событий:** Система (фронтенд) обязана игнорировать (отсеивать) непрерывный поток событий `oninput` от ползунков. Отправка POST-запроса на сервер допускается только через **250 мс** после остановки движения макро-слайдера (debounce time), чтобы не перегружать CPU сервера (защита от DDoS).

---

## 6. Обработка отказов (Fault Tolerance & Edge Cases)

| Сценарий (Edge Case) | Триггер | Реакция системы (Fallback) |
| :--- | :--- | :--- |
| **NaN / Ошибка расчета** | Математическая ошибка в JS приводит к `NaN` или `undefined` | Принудительная подстановка Default-значений матрицы. Блокировка отправки POST-запроса. |
| **Инъекция через Console** | Пользователь вручную задает $C = 999$ через DevTools | Жесткий Client-Side Clamping (функции `Math.min`/`Math.max`) срезает значение до 100 перед расчетом. |

---

## 7. Ожидаемый артефакт (Final Deliverable)

* **Измененные файлы:** Исключительно `static/index.html`, `static/style.css`, `static/app.js`.
* **Критерий приемки (DoD):**
    * При запуске приложения интерфейс показывает только 3 макро-слайдера.
    * Перемещение слайдера "Warmth" на 100% не вызывает падения бэкенда, а звук становится более компрессированным и басистым (формируется JSON с `formant_ratio: 0.85`).
    * При переключении в "Pro Mode" пользователь видит, как 10 инженерных слайдеров выстроились в соответствии с математикой, описанной в Разделе 3.

---

## Пример JS-код функции-маппера для файла `app.js`. 

Код строго реализует матрицу PCA из спецификации, включает защиту от некорректных входных данных (Sanitize) и принудительное ограничение значений (Clamping) перед сборкой итогового Payload.

### Имплементация логики в `app.js`

```javascript
/**
 * T-SPEC COMPLIANT: MACRO TO MICRO MAPPER
 * Выполняет однонаправленный перевод абстрактных макро-шкал UI 
 * в физические параметры для DSP-движка сервера.
 * * @param {number|string} clarity - Разборчивость (0..100)
 * @param {number|string} warmth - Бархат (0..100)
 * @param {number|string} vocalAge - Износ связок (-100..100)
 * @returns {Object} Валидный JSON Payload для POST /process_audio
 */
function calculateMicroParams(clarity, warmth, vocalAge) {
    // 1. Защита входов (Sanitization & Input Clamping)
    // Предотвращает ошибки, если в функцию попал NaN, undefined или выход за пределы
    const C = Math.max(0, Math.min(100, Number(clarity) || 0));
    const W = Math.max(0, Math.min(100, Number(warmth) || 0));
    const A = Math.max(-100, Math.min(100, Number(vocalAge) || 0));

    // 2. Расчет Оси 1: Clarity (Разборчивость)
    const f2_shift = Math.min(200.0, C * 2.0);
    const presence_db = Math.min(6.0, C * 0.06);
    const deesser_amount = Math.min(50.0, C * 0.5);

    // 3. Расчет Оси 2: Warmth (Бархат)
    const formant_ratio = Math.max(0.85, 1.0 - (W * 0.0015));
    const pitch_ratio = Math.max(0.95, 1.0 - (W * 0.0005));
    const compression = Math.min(80.0, 50.0 + (W * 0.3));
    const noise_gate_db = Math.min(-50.0, -60.0 + (W * 0.1));

    // 4. Расчет Оси 3: Vocal Age (Износ связок)
    const jitter_mod = Math.max(-1.0, Math.min(1.0, A * 0.01));
    const breathiness_mod = A > 0 ? Math.min(60.0, A * 0.6) : 0.0;

    // 5. Сборка детерминированного Payload 
    // Метод toFixed() предотвращает отправку длинных дробей (float noise) на сервер
    return {
        basic: {
            pitch_ratio: Number(pitch_ratio.toFixed(3)),
            formant_ratio: Number(formant_ratio.toFixed(3)),
            presence_db: Number(presence_db.toFixed(1)),
            compression: Number(compression.toFixed(1))
        },
        advanced: {
            f1_shift: 0.0, // Жестко заблокировано для защиты основного тембра
            f2_shift: Number(f2_shift.toFixed(1)),
            jitter_mod: Number(jitter_mod.toFixed(3)),
            breathiness_mod: Number(breathiness_mod.toFixed(1)),
            noise_gate_db: Number(noise_gate_db.toFixed(1)),
            deesser_amount: Number(deesser_amount.toFixed(1))
        }
    };
}

// ==========================================
// Пример интеграции с событиями UI
// ==========================================

let debounceTimer;

function handleMacroSliderChange() {
    // Получаем текущие значения с абстрактных ползунков
    const clarityVal = document.getElementById('macro-clarity').value;
    const warmthVal = document.getElementById('macro-warmth').value;
    const ageVal = document.getElementById('macro-age').value;

    // Рассчитываем физические параметры
    const payload = calculateMicroParams(clarityVal, warmthVal, ageVal);

    // Опционально: синхронизация UI (физически двигаем ползунки в скрытом Pro-режиме)
    // syncProSliders(payload);

    // Изоляция шума: Debounce 250ms перед отправкой на бэкенд
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        sendToAudioEngine(payload);
    }, 250);
}

function sendToAudioEngine(payload) {
    console.log("Отправка Payload на сервер:", JSON.stringify(payload, null, 2));
    // fetch('/process_audio', { method: 'POST', body: JSON.stringify(payload) ... })
}
```

---
