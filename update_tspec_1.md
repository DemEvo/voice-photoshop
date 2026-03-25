
---
   
# T-SPEC: ADVANCED MODE — ГЛУБОКАЯ АКУСТИЧЕСКАЯ РЕТУШЬ

## 1. Ограничительная рамка (Core Restrictions & Boundary Conditions)
Раздел определяет жесткие инженерные запреты для исключения галлюцинаций и использования недопустимых технологий.

* **❌ STRICTLY FORBIDDEN:**
    * Использование любых нейросетевых моделей (RVC, So-VITS, RNNoise).
    * Использование внешних API или сторонних VST-плагинов.
    * Превышение лимита времени обработки в **4.0 секунды** на 15 секунд аудио.
    * Модификация корней LPC с частотой ниже **800 Гц** (защита F1).
* **✅ EXPLICITLY ALLOWED:**
    * **Backend:** Python 3.10+, FastAPI.
    * **DSP Engine:** `praat-parselmouth` (LPC Burg, PointProcess) и `pedalboard`.
    * **Синтез:** Метод **Overlap-Add (OLA)** для предотвращения металлических щелчков.

## 2. Детерминированный поток (State Machine)
Процесс разложен на тактовые переходы состояний для устранения двусмысленности.

1.  **[Trigger: Переключен Toggle Advanced]** -> [UI: Отображение панелей A, B, C] -> **[State: ADVANCED_ACTIVE]**.
2.  **[Trigger: Изменение ползунка]** -> [Backend: Применение NoiseGate к потоку] -> **[State: PREPROCESSED]**.
3.  **[Trigger: LPC-анализ]** -> [Backend: Сдвиг корней F2/F3 на основе адаптивного порядка (12/16)] -> **[State: PRAAT_MODIFIED]**.
4.  **[Trigger: Параллельный De-Esser]** -> [Backend: Разделение (5кГц) -> RMS-компрессия -> Суммирование] -> **[State: POSTPROCESSED]**.
5.  **[Trigger: Финализация]** -> [Backend: Peak Normalization (-1.0 dBFS) -> 16-bit WAV] -> **[State: READY_FOR_EXPORT]**.

## 3. Трансформация данных (Data Mutators & I/O)
Спецификация входных и выходных форматов.

* **Входной JSON (Payload):** 
    * `basic`: { `pitch_ratio` (log scale), `formant_ratio` (linear), `presence_db`, `compression` }.
    * `advanced`: { `f1_shift`, `f2_shift`, `jitter_mod`, `breathiness_mod`, `noise_gate_db`, `deesser_amount` }.
* **Выход:** Бинарный поток `audio/wav` (PCM 16-bit, Mono).

## 4. Логика маппинга (Mapping & Normalization)
Правила пересчета UI-значений (0–100%) в физические величины.

* **Pitch Ratio:** Логарифмическая шкала (диапазон 0.5 – 2.0).
* **Formant Ratio:** Линейная шкала (диапазон 0.8 – 1.2).
* **De-Esser Threshold:** Инвертированная шкала (0% = 0 dB; 100% = -60 dB).
* **LPC Order:** Автоматический выбор: $F_0 < 150$ Гц $\to$ order 16; $F_0 > 150$ Гц $\to$ order 12.

## 5. Изоляция шума (Noise Reduction Parameters)
Параметры, отсеиваемые при обработке.

* **Noise Gate:** Глушение сигналов ниже порога `noise_gate_db` до уровня -100 dB.
* **De-Esser Split:** Частоты ниже **5000 Гц** при Q=0.707 игнорируются детектором компрессора.

## 6. Обработка отказов (Fault Tolerance & Edge Cases)
Реакция системы на критические ситуации.

* **LPC Instability:** При возникновении неустойчивых полюсов фильтра — возврат `HTTP 422` с текстом «DSP Error».
* **Clipping Protection:** Автоматическое ограничение амплитуды блоком **Limiter** на уровне **-1.0 dBFS**.
* **Timeout:** Если обработка > 4.0 сек — прерывание и возврат `HTTP 408`.

## 7. Ожидаемый артефакт (Final Deliverable)
Критерий приемки (Definition of Done).

* **Результат:** Пакет с обновленным FastAPI-сервером и поддержкой «Advanced Mode».
* **Тестовый прогон:**
    * **Ввод [X]:** 15 сек вокала. Настройки: `f2_shift: 150`, `jitter_mod: -0.5`, `deesser_amount: 70`.
    * **Вывод [Y]:** Обработанный 16-bit WAV, где шум в паузах отсутствует, свистящие звуки смягчены (RMS-детекция), а артикуляция усилена без изменения тембра (F1).

---
