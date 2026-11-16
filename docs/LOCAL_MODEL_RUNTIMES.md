# Local Model Runtimes

KnowMotion uses three GGML-based native runtimes instead of loading every model
through one process:

| Capability | Runtime | Provider protocol |
| --- | --- | --- |
| LLM and text embedding | `llama.cpp` / `llama-server` | `GGUF` |
| TTS and ASR | [`audio.cpp`](https://github.com/0xShug0/audio.cpp) / `audiocpp_server` | `audio.cpp` |
| Image generation and editing | [`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp) / `sd-server` | `stable-diffusion.cpp` |

The runtimes are separate processes. A GGUF file is only compatible with the
runtime that implements its architecture; changing a file extension or loader
does not make a TTS, ASR, or diffusion checkpoint runnable by `llama-server`.

## On-demand runtime installation

Runtime binaries are not bundled with the application and are not downloaded
when the app starts. The installer runs only after the user selects a local
model runtime:

1. Run `nvidia-smi --query-gpu=driver_version,compute_cap` to detect a usable
   NVIDIA GPU and driver.
2. If the driver is CUDA 12.4-compatible, download the CUDA variant and its
   matching CUDA runtime libraries.
3. Otherwise download the portable Vulkan variant.
4. Verify every archive with its pinned SHA-256 before extraction.
5. Store the verified runtime and its manifest under
   `%APPDATA%/com.knowmotion.studio/runtimes/`.

Downloading a runtime does not download model weights.

## Model set

The recommended 12 GB VRAM set is:

| Task | Package |
| --- | --- |
| LLM | `unsloth/Qwen3.8-27B-GGUF`, `Qwen3.8-27B-UD-Q2_K_XL.gguf` |
| Embedding | `Qwen/Qwen3-Embedding-0.6B-GGUF`, `Qwen3-Embedding-0.6B-Q8_0.gguf` |
| TTS | audio.cpp `qwen3_tts_1_7b_customvoice_q8_0` |
| ASR | audio.cpp `qwen3_asr_1_7b_q8_0` |
| Optional alignment | audio.cpp `qwen3_forced_aligner_0_6b_q8_0` |
| Image | stable-diffusion.cpp Qwen Image 2.1 GGUF plus its Qwen3-VL encoder and VAE |

`audio.cpp` currently provides the Qwen3-TTS CustomVoice package for the 1.7B
checkpoint. If the 0.6B model is mandatory, use the 0.6B Base package with a
reference WAV and transcript instead of assuming it has the CustomVoice presets.

Qwen Image 2.1 requires all three components:

```text
qwen-image-2.1-Q4_K_M.gguf
Qwen3VL-8B-Instruct-Q4_K_M.gguf
qwen_image_2.1_vae_bf16.safetensors
```

Use the matching VAE from
[`Comfy-Org/Qwen-Image-2.1`](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)
and the diffusion GGUF from
[`leejet/Qwen-Image-2.1-GGUF`](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF).
Qwen-Image-2.1 remains subject to the Qwen Research License.

## audio.cpp

Selecting `audio.cpp` in Models downloads the correct runtime package. Model
weights are still managed separately with audio.cpp's native model manager:

```powershell
audiocpp_model_manager install qwen3_tts_1_7b_customvoice_q8_0 --models-root D:/models
audiocpp_model_manager install qwen3_asr_1_7b_q8_0 --models-root D:/models
```

An example `audio-server.json`:

```json
{
  "host": "127.0.0.1",
  "port": 8080,
  "backend": "vulkan",
  "lazy_load": true,
  "max_loaded_models": 1,
  "models": [
    {
      "id": "qwen3-tts",
      "family": "qwen3_tts",
      "path": "D:/models/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
      "task": "tts",
      "mode": "offline",
      "default_voice_preset": { "voice_id": "serena" }
    },
    {
      "id": "qwen3-asr",
      "family": "qwen3_asr",
      "path": "D:/models/Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf",
      "task": "asr",
      "mode": "offline"
    }
  ]
}
```

Start it with:

```powershell
audiocpp_server.exe --config audio-server.json --no-ui
```

In KnowMotion, add separate `audio.cpp` Providers:

```text
Base URL: http://127.0.0.1:8080
Model:    qwen3-tts
Capability: TTS

Base URL: http://127.0.0.1:8080
Model:    qwen3-asr
Capability: ASR
```

`max_loaded_models: 1` makes audio.cpp unload the least-recently-used idle model
before loading another one. To release all audio GPU memory immediately:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8080/v1/tasks/unload_all_models
```

KnowMotion uses `/v1/audio/speech` for TTS. For ASR it uses
`/v1/audio/transcriptions/details` and converts `start_sample`/`end_sample`
using `sample_rate` when the model returns segments.

Qwen3-TTS CustomVoice does not declare a speech-rate multiplier in audio.cpp.
The app therefore leaves rate unchanged for this runtime. Use a different voice
or a Base checkpoint with a reference recording when pacing must be controlled.

## stable-diffusion.cpp

Selecting `stable-diffusion.cpp` in Models downloads the runtime package. Place
the model components under a model directory:

```text
models/
├─ diffusion_models/qwen-image-2.1-Q4_K_M.gguf
├─ text_encoders/Qwen3VL-8B-Instruct-Q4_K_M.gguf
└─ vae/qwen_image_2.1_vae_bf16.safetensors
```

Start the server:

```powershell
sd-server.exe --model-dir D:/models
```

Open `http://127.0.0.1:1234/`, choose the `qwen-image-21` recipe, assign the
three files, and load the model. The server also exposes:

```text
GET  /sdcpp/v1/models/status
POST /sdcpp/v1/models/load
POST /sdcpp/v1/models/unload
POST /v1/images/generations
POST /v1/images/edits
```

In KnowMotion, add a `stable-diffusion.cpp` Provider:

```text
Base URL:   http://127.0.0.1:1234
Model:      sd-cpp-local
Capability: Image
```

The app sends `response_format: b64_json` and reuses the existing image
generation and inpainting pipeline. Before a large generation, keep the model
at 1024×1024 or lower and keep `llama.cpp` unloaded.

## Resource lifecycle

The current integration connects to already-running audio.cpp and
stable-diffusion.cpp servers. A future Rust `LocalModelScheduler` should own all
three processes and enforce one GPU-heavy lease at a time:

1. Stop any idle `llama-server` before TTS, ASR, or image work.
2. Use audio.cpp `max_loaded_models: 1`.
3. Call stable-diffusion.cpp `/sdcpp/v1/models/unload` after an image batch.
4. Call audio.cpp `/v1/tasks/unload_all_models` before starting diffusion.
5. Preserve a 768–1024 MiB device-memory margin.
6. Idle-unload the LLM after 180 seconds and audio models after 60 seconds.

