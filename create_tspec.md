
---

# T-SPEC: MVP LOCAL VOICE REFERENCE EDITOR ("VOICE PHOTOSHOP")

## 1. Ограничительная рамка (Core Restrictions & Boundary Conditions)

[cite_start]В данном разделе зафиксированы жесткие технологические и архитектурные запреты для обеспечения локальной работы без нейросетевых мощностей. [cite: 1156, 1204, 1624]

* **❌ STRICTLY FORBIDDEN:**
    * [cite_start]Использование локальных или облачных нейросетевых моделей (RVC, So-VITS, GPT-SoVITS). [cite: 1157, 1626]
    * [cite_start]Использование внешних API для обработки звука (ElevenLabs, Adobe Podcast). [cite: 1157, 1626]
    * [cite_start]Библиотеки `librosa` для изменения питча (из-за сильных артефактов "роботизации"). [cite: 1157, 1626]
    * [cite_start]Хранение аудиоданных в базе данных (только RAM или временная директория `/tmp`). [cite: 1157, 1626]
* **✅ EXPLICITLY ALLOWED:**
    * [cite_start]**Backend:** Python 3.10+, FastAPI. [cite: 1158, 1628]
    * [cite_start]**DSP Engine:** `praat-parselmouth` (алгоритм Change Gender), `pedalboard`. [cite: 1158, 1628]
    * [cite_start]**Frontend:** Vanilla JS, Web Audio API (для воспроизведения). [cite: 1158, 1628]
    * [cite_start]**Format:** Только WAV (PCM 16-bit, Mono, 44100/48000 Hz). [cite: 1158, 1628]

---

## 2. Детерминированный поток (State Machine)

[cite_start]Описание логики взаимодействия через тактовые переходы состояний субъектов. [cite: 1160, 1633, 1638]

1.  [cite_start]`[Пользователь: Загрузил WAV]` -> `[Система: Валидация формата и сохранение в RAM]` -> `[Состояние: READY_TO_EDIT]` [cite: 1162, 1639]
2.  [cite_start]`[Пользователь: Изменил Slider (Pitch/Formant)]` -> `[Система: Вызов parselmouth.praat.call("Change gender")]` -> `[Состояние: DSP_PROCESSED]` [cite: 1162, 1639, 1640]
3.  [cite_start]`[Система: Наложение Pedalboard (EQ/Comp)]` -> `[Система: Генерация временного бинарного потока]` -> `[Состояние: READY_TO_PREVIEW]` [cite: 1162, 1639, 1640]
4.  [cite_start]`[Пользователь: Нажал Play]` -> `[Система: Передача Blob в тег <audio>]` -> `[Состояние: PLAYING]` [cite: 1162, 1639, 1640]
5.  [cite_start]`[Пользователь: Нажал Export]` -> `[Система: Финализация WAV и инициирование скачивания]` -> `[Состояние: DONE]` [cite: 1162, 1639, 1640]

---

## 3. Трансформация данных (Data Mutators & I/O)

[cite_start]Спецификация структуры входных и выходных данных для API-обмена. [cite: 1164, 1206]

* [cite_start]**Входной формат (POST `/process`):** [cite: 1165]
    ```json
    {
      "pitch_ratio": 1.15,      // float 0.7-1.3
      "formant_ratio": 0.85,    // float 0.7-1.3
      "presence_db": 5.0,       // float 0-10
      "compression_level": 0.5  // float 0.0-1.0
    }
    ```
* [cite_start]**Выходной формат:** [cite: 1166]
    * `Binary Stream (Content-Type: audio/wav)` — обработанный фрагмент для мгновенного превью.
    * `Filename Convention:` `golden_ref_[timestamp].wav` (при экспорте).

---

## 4. Изоляция шума (Noise Reduction Parameters)

[cite_start]Параметры данных, которые система обязана игнорировать. [cite: 1167, 1646]

* [cite_start]**Исключения (Ignore List):** [cite: 1168, 1651]
    * Метаданные (ID3-теги, EXIF-данные) исходного файла.
    * Стерео-каналы (принудительное сведение в Mono при загрузке).
    * [cite_start]Тишина в начале/конце файла (автоматический тримминг по порогу -40dB). [cite: 1652]

---

## 5. Обработка отказов (Fault Tolerance & Edge Cases)

[cite_start]Реакция системы на критические сбои и лимиты. [cite: 1169, 1657, 1660]

| Сценарий (Edge Case) | Ограничение / Лимит | Реакция системы (Fallback) |
| :--- | :--- | :--- |
| **Длительность файла** | > 20 секунд | [cite_start]Обрезка до первых 15 секунд, статус 206 Partial Content. [cite: 1171, 1661, 1663] |
| **Пустой вход (Silence)** | RMS < 0.001 | [cite_start]Ошибка: "Audio is empty or too quiet". [cite: 1172, 1662, 1663] |
| **Память (RAM Buffer)** | > 50MB на файл | [cite_start]Принудительная очистка буфера, сброс состояния. [cite: 1171, 1661, 1663] |
| **Сбой DSP (Praat)** | Timeout > 2 сек | [cite_start]Возврат оригинального файла с алертом "Processing Timeout". [cite: 1171, 1662, 1663] |

---

## 6. Ожидаемый артефакт (Final Deliverable)

[cite_start]Критерии приемки и эталонный результат. [cite: 1173, 1209]

* [cite_start]**Результат:** Python-пакет с локальным сервером и папкой `/static` (HTML/JS). [cite: 1174]
* [cite_start]**Тестовый прогон (Definition of Done):** [cite: 1175, 1560]
    * **Вход [X]:** Файл `vocal_raw.wav` (мужской голос, 100Hz).
    * **Параметры:** `pitch_ratio: 1.2`, `formant_ratio: 1.1`.
    * **Выход [Y]:** Файл `golden_ref.wav` (голос звучит выше по тону, гортань физиологически "уменьшена", сохранена естественность артикуляции). Отсутствие эффекта "хоруса" или металлических призвуков.

---

