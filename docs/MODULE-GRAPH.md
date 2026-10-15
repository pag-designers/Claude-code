# Clipfern module graph

Generated from the real `import`s of 621 TypeScript files (`shared/`, `electron/`, `renderer/`; tests, the generated migration file and the Python sidecar excluded). Numbers on an arrow are the count of import statements from one module group to another. Regenerate with the script in the PR description or by asking for a refresh.

## Layers

```mermaid
flowchart LR
  Main_DB["Main DB<br/>2 files · 173 lines"]
  Main_IPC["Main IPC<br/>3 files · 446 lines"]
  Main_core["Main core<br/>3 files · 688 lines"]
  Main_pipeline["Main pipeline<br/>23 files · 9,419 lines"]
  Main_services["Main services<br/>155 files · 34,097 lines"]
  Preload["Preload<br/>1 files · 40 lines"]
  Renderer["Renderer<br/>421 files · 78,730 lines"]
  Shared["Shared<br/>13 files · 5,693 lines"]
  Renderer -->|338| Shared
  Main_services -->|120| Shared
  Main_services -->|60| Main_pipeline
  Main_pipeline -->|51| Shared
  Main_pipeline -->|44| Main_services
  Main_pipeline -->|11| Main_DB
  Main_IPC -->|11| Main_pipeline
  Main_pipeline -->|9| Main_IPC
  Main_services -->|7| Main_DB
  Main_core -->|6| Main_services
  Main_services -->|6| Main_core
  Main_IPC -->|5| Shared
  Main_core -->|3| Shared
  Main_core -->|2| Main_IPC
  Main_core -->|2| Main_pipeline
  Main_pipeline -->|2| Main_core
  Main_IPC -->|2| Main_services
  Main_IPC -->|1| Main_core
  Preload -->|1| Shared
```

## Main process: who depends on whom

Only links with 2+ imports are drawn. `pipeline` is the orchestration layer; `services/*` are the leaf capabilities (media, llm, captions, publish-_, brand-_, …).

```mermaid
flowchart LR
  main_core["core<br/>3 files"]
  main_db["db<br/>2 files"]
  main_ipc["ipc<br/>3 files"]
  main_pipeline["pipeline<br/>23 files"]
  main_services_brand_finish["services/brand-finish<br/>3 files"]
  main_services_brand_media["services/brand-media<br/>8 files"]
  main_services_captions["services/captions<br/>12 files"]
  main_services_chat["services/chat<br/>6 files"]
  main_services_context["services/context<br/>1 files"]
  main_services_cost["services/cost<br/>1 files"]
  main_services_editor_export["services/editor-export<br/>9 files"]
  main_services_editor_media["services/editor-media<br/>2 files"]
  main_services_llm["services/llm<br/>20 files"]
  main_services_media["services/media<br/>3 files"]
  main_services_notifications["services/notifications<br/>1 files"]
  main_services_publish["services/publish<br/>4 files"]
  main_services_publish_instagram["services/publish-instagram<br/>7 files"]
  main_services_publish_media["services/publish-media<br/>6 files"]
  main_services_publish_tiktok["services/publish-tiktok<br/>6 files"]
  main_services_publish_youtube["services/publish-youtube<br/>9 files"]
  main_services_queue["services/queue<br/>1 files"]
  main_services_reframe["services/reframe<br/>13 files"]
  main_services_render["services/render<br/>9 files"]
  main_services_settings["services/settings<br/>1 files"]
  main_services_storage["services/storage<br/>5 files"]
  main_services_thumbnails["services/thumbnails<br/>3 files"]
  main_services_chat -->|16| main_services_llm
  main_services_llm -->|13| main_pipeline
  main_services_reframe -->|11| main_pipeline
  main_pipeline -->|11| main_db
  main_ipc -->|11| main_pipeline
  main_pipeline -->|9| main_ipc
  main_services_brand_media -->|7| main_pipeline
  main_pipeline -->|7| main_services_storage
  main_pipeline -->|6| main_services_publish
  main_services_brand_media -->|5| main_services_media
  main_services_publish_youtube -->|5| main_services_publish
  main_services_llm -->|5| main_services_chat
  main_pipeline -->|5| main_services_queue
  main_services_editor_export -->|4| main_services_render
  main_services_editor_export -->|4| main_services_captions
  main_services_publish_youtube -->|4| main_pipeline
  main_services_llm -->|4| main_services_cost
  main_services_publish_media -->|4| main_services_render
  main_services_brand_finish -->|4| main_services_render
  main_services_context -->|3| main_services_storage
  main_services_llm -->|3| main_core
  main_services_publish_instagram -->|3| main_services_publish
  main_services_publish_media -->|3| main_pipeline
  main_services_publish_tiktok -->|3| main_services_publish
  main_core -->|2| main_ipc
  main_core -->|2| main_pipeline
  main_core -->|2| main_services_brand_media
  main_services_queue -->|2| main_db
  main_services_editor_export -->|2| main_pipeline
  main_services_editor_media -->|2| main_pipeline
  main_services_editor_media -->|2| main_services_media
  main_services_media -->|2| main_pipeline
  main_services_render -->|2| main_pipeline
  main_services_chat -->|2| main_pipeline
  main_services_thumbnails -->|2| main_pipeline
  main_services_thumbnails -->|2| main_services_render
  main_services_brand_finish -->|2| main_pipeline
  main_pipeline -->|2| main_services_notifications
  main_pipeline -->|2| main_core
  main_pipeline -->|2| main_services_context
  main_pipeline -->|2| main_services_settings
  main_pipeline -->|2| main_services_llm
  main_pipeline -->|2| main_services_media
```

## Largest module groups

| Group                         | Files | Lines  |
| ----------------------------- | ----- | ------ |
| `ui/components/editor`        | 99    | 19,427 |
| `ui/lib/editor`               | 54    | 12,562 |
| `main/pipeline`               | 23    | 9,419  |
| `ui/components/brand`         | 23    | 5,920  |
| `shared`                      | 13    | 5,693  |
| `ui/components/library`       | 14    | 5,585  |
| `main/services/llm`           | 20    | 4,771  |
| `ui/components/scheduler`     | 16    | 4,746  |
| `ui/other`                    | 34    | 4,210  |
| `ui/components/settings`      | 14    | 3,082  |
| `ui/components/pages`         | 14    | 3,060  |
| `main/services/editor-export` | 9     | 2,904  |
| `main/services/captions`      | 12    | 2,896  |
| `ui/components/ui`            | 35    | 2,413  |
| `main/services/reframe`       | 13    | 2,115  |
| `main/services/brand-media`   | 8     | 2,027  |
| `main/services/render`        | 9     | 2,019  |
| `ui/lib/brand`                | 10    | 1,835  |

## Most imported files (fan-in)

| File                                  | Imported by |
| ------------------------------------- | ----------- |
| `renderer/lib/utils.ts`               | 156         |
| `shared/editor.ts`                    | 130         |
| `renderer/components/ui/button.tsx`   | 108         |
| `shared/pipeline.ts`                  | 105         |
| `shared/cp2.ts`                       | 75          |
| `renderer/lib/ipc.ts`                 | 63          |
| `shared/brand.ts`                     | 55          |
| `shared/editor-eval.ts`               | 54          |
| `renderer/components/ui/skeleton.tsx` | 53          |
| `renderer/lib/format.ts`              | 50          |
| `renderer/components/ui/tooltip.tsx`  | 47          |
| `shared/publish.ts`                   | 42          |

## Reading it

- `Shared` (the Zod IPC contract and the pure evaluators `editor-eval`, `scheduling`, `brand-apply`) is imported by every layer and imports nothing from them: that is the intended direction.
- The renderer reaches the main process only through `Preload` / IPC; there should be no arrow from `Renderer` to any `Main *` group.
- `Main pipeline` is where services are combined. The many `services/* → pipeline` arrows are only imports of the `pipeline/contracts*.ts` interface files (checked: no service imports any other pipeline file). That is the contract-first design, so the interfaces live next to the orchestrators that consume them.
