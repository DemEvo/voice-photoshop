---

# T-SPEC: 1-TO-1 ANALYTICAL BASELINE EXTRACTION

## 1. Ограничительная рамка (Core Restrictions & Boundary Conditions)

Спецификация фиксирует жесткие правила извлечения акустических данных на этапе инициализации файла.

* **❌ STRICTLY FORBIDDEN:**
    * Использование нейросетевых анализаторов, сторонних библиотек (кроме `praat-parselmouth` и `numpy`) или внешних API для получения метрик.
    * Выполнение акустического анализа на стороне клиента (в браузере).
    * Блокировка ответа эндпоинта `/upload` более чем на 2.5 секунды для файла длительностью 15 секунд.
* **✅ EXPLICITLY ALLOWED:**
    * Детерминированный расчет 9 физических метрик строго на бэкенде (`main.py`) во время обработки POST-запроса `/upload`.
    * Прямая модификация DOM-узлов (textContent) в `app.js` для отображения полученных Baseline-значений в режиме Pro.

## 2. Детерминированный поток (State Machine)

Тактовые переходы при инициализации нового аудиофайла.

1. `[Пользователь: Загружает WAV-файл через форму]` -> `[Система (Frontend): Отправляет POST-запрос на /upload]` -> `[Состояние: UPLOAD_IN_PROGRESS]`.
2. `[Система (Backend): Сохраняет аудио в буфер и запускает экстракцию 9 параметров]` -> `[Система (Backend): Формирует итоговый JSON-ответ]` -> `[Состояние: METRICS_CALCULATED]`.
3. `[Система (Frontend): Получает HTTP 200 OK с объектом metrics]` -> `[Система (Frontend): Извлекает данные и перезаписывает DOM-элементы (например, span с id="baseline-jitter")]` -> `[Состояние: BASELINES_RENDERED]`.

## 3. Трансформация данных (Data Mutators & I/O)

Логика получения физических величин из сырого сигнала и схема ответа API.

**Алгоритмы извлечения (Backend Mutators):**

* `baseline_pitch`: Вызов `To Pitch`, извлечение медианы F0 в Гц.
* `baseline_f1`: Вызов `To Formant (burg)`, извлечение медианы 1-й форманты в Гц.
* `baseline_f2`: Вызов `To Formant (burg)`, извлечение медианы 2-й форманты в Гц.
* `baseline_jitter`: Вызов `To PointProcess (periodic, cc)`, вызов `Get jitter (local)`, конвертация в проценты (%).
* `baseline_hnr`: Вызов `To Harmonicity (cc)`, извлечение среднего HNR в дБ.
* `baseline_presence`: Конвертация в массив `numpy`, расчет доли RMS-энергии на частотах выше 3000 Гц.
* `baseline_crest_factor`: Расчет отношения пиковой амплитуды к общему RMS сигнала в дБ (Peak-to-RMS).
* `baseline_noise_floor`: Расчет RMS для нижнего 5-го перцентиля амплитуд массива `numpy` в дБ.
* `baseline_sibilance`: Применение полосового фильтра (5000-8000 Гц), расчет пиковой энергии в дБ.

**Выходной формат API (Payload Response):**

```json
{
  "file_id": "a1b2c3d4-uuid",
  "message": "Uploaded successfully",
  "metrics": {
    "pitch_hz": 115.4,
    "f1_hz": 450.2,
    "f2_hz": 1200.5,
    "jitter_pct": 1.8,
    "hnr_db": 14.2,
    "hf_energy_ratio": 0.12,
    "crest_factor_db": 18.5,
    "noise_floor_db": -45.0,
    "sibilance_peak_db": -12.4
  }
}
```

## 4. Изоляция шума (Noise Reduction Parameters)

Данные, которые алгоритмы экстракции обязаны игнорировать для обеспечения точности:

* **Unvoiced Frames (Глухие звуки):** При расчете `baseline_pitch`, `baseline_f1` и `baseline_f2` алгоритм должен игнорировать фреймы, где F0 не определяется (значение 0), чтобы паузы и шипящие звуки не искажали медиану.
* **Transient Peaks (Щелчки):** При расчете `baseline_noise_floor` жестко отсекаются верхние 95% амплитуд (анализируется только "дно" сигнала).

## 5. Обработка отказов (Fault Tolerance & Edge Cases)

Матрица сбоев при извлечении метрик и детерминированная реакция системы.

| Триггер сбоя | Ограничение / Условие | Точная реакция системы (Fallback) |
| :--- | :--- | :--- |
| **Аудиофайл слишком короткий** | Длительность < 0.5 сек (Praat не может построить окно) | Возврат `null` для параметров гортани. Текст в UI: `Original: N/A`. |
| **Абсолютная тишина** | RMS сигнала < 0.0001 | Возврат `0.0` для всех `numpy`-метрик и `null` для Praat-метрик. |
| **Слишком высокий шум (Нет F0)** | HNR < 0 дБ на всем протяжении файла | Возврат `null` для `baseline_pitch` и `baseline_jitter`. Текст в UI: `Original: Unvoiced`. |

## 6. Ожидаемый артефакт (Final Deliverable)

Критерии успешного внедрения аналитического слоя.

* **Артефакт:** Обновленный метод загрузки в `main.py` и логика парсинга в `app.js`.
* **Тестовый прогон (DoD):**
    * Ввод [X]: Файл `test_voice.wav` загружается через UI.
    * Вывод [Y]: Бэкенд возвращает JSON за время < 2.5 сек. В Pro-режиме под ползунком `Jitter` появляется текст `Original: 1.8%`, под ползунком `De-Esser` появляется текст `Peak Sibilance: -12.4 dB`. Ошибок в консоли браузера нет.

---
## Примерный Python-код для математически корректного извлечения `baseline_crest_factor` и `baseline_noise_floor` с использованием библиотеки `numpy`

```python
import numpy as np

def extract_numpy_baselines(audio_array: np.ndarray) -> dict:
    """
    T-SPEC COMPLIANT: NUMPY BASELINE EXTRACTION
    Извлекает физические метрики динамики из моно-аудиосигнала.
    
    :param audio_array: 1D numpy array со значениями амплитуды (float32, диапазон [-1.0, 1.0]).
    :return: Словарь с рассчитанными значениями в децибелах (dB).
    """
    
    # 1. Защита от граничных случаев: проверка на абсолютную тишину
    # Вычисляем общий RMS (Root Mean Square) всего сигнала
    total_rms = np.sqrt(np.mean(audio_array**2))
    
    if total_rms < 0.0001:
        # Сигнал слишком тихий, возвращаем нули согласно Fault Tolerance матрице
        return {
            "baseline_crest_factor_db": 0.0,
            "baseline_noise_floor_db": 0.0
        }

    # ==========================================
    # 2. РАСЧЕТ CREST FACTOR (baseline_crest_factor)
    # Пик-фактор показывает разницу между пиковыми значениями и средней энергией.
    # ==========================================
    peak_amplitude = np.max(np.abs(audio_array))
    # Формула: 20 * log10(Peak / RMS)
    # Добавляем 1e-10 для предотвращения ошибки логарифма нуля (хотя мы уже отсеяли тишину)
    crest_factor_db = 20 * np.log10(peak_amplitude / (total_rms + 1e-10))

    # ==========================================
    # 3. РАСЧЕТ УРОВНЯ ШУМА (baseline_noise_floor)
    # Оценка фонового шума помещения по нижнему 5-му перцентилю амплитуд.
    # ==========================================
    abs_audio = np.abs(audio_array)
    
    # Находим порог (амплитуду), ниже которого лежат 5% самых тихих сэмплов сигнала
    percentile_5_threshold = np.percentile(abs_audio, 5)
    
    # Изолируем эти тихие сэмплы (отсекаем голос и артефакты)
    quietest_samples = audio_array[abs_audio <= percentile_5_threshold]
    
    # Вычисляем RMS только для "тишины"
    noise_rms = np.sqrt(np.mean(quietest_samples**2))
    
    # Переводим в дБ относительно цифрового нуля (Full Scale)
    noise_floor_db = 20 * np.log10(noise_rms + 1e-10)

    # 4. Формирование детерминированного вывода (округление до 1 знака)
    return {
        "baseline_crest_factor_db": round(float(crest_factor_db), 1),
        "baseline_noise_floor_db": round(float(noise_floor_db), 1)
    }

# ==========================================
# Пример вызова в эндпоинте /upload:
# ==========================================
if __name__ == "__main__":
    # Симуляция 1 секунды аудио (44100 Hz): смесь синусоиды (голос) и белого шума
    sample_rate = 44100
    t = np.linspace(0, 1, sample_rate)
    voice_signal = 0.5 * np.sin(2 * np.pi * 440 * t)  # Тон 440 Гц
    room_noise = 0.005 * np.random.normal(0, 1, sample_rate) # Шум комнаты (-46 дБ)
    
    # Собираем финальный массив и тестируем функцию
    mock_audio = voice_signal + room_noise
    
    metrics = extract_numpy_baselines(mock_audio)
    print(f"Извлеченные метрики: {metrics}")
    # Ожидаемый результат: 
    # Crest Factor будет около 3.0 dB (стандарт для синусоиды),
    # Noise Floor покажет объективный уровень добавленного шума (~ -45...-46 dB).
```
