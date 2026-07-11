# SceneFlow AI

Xưởng video tự động: biến một brief thành storyboard có continuity, tạo từng cảnh 4/6/8 giây bằng Veo, kiểm tra chất lượng, rồi ghép thành một video dài trên timeline chung.

## Trạng thái triển khai

| Phase | Phạm vi | Trạng thái |
| --- | --- | --- |
| 01 | Studio UI, tạo dự án, đăng nhập ChatGPT | Hoàn tất MVP |
| 02 | Prompt compiler, Story Bible, storyboard 4 cảnh | Hoàn tất MVP |
| 03 | Hàng đợi, phụ thuộc cảnh trước, QC mô phỏng | Hoàn tất MVP |
| 04 | D1, R2, quyền sở hữu, credit ledger, Veo adapter | Hoàn tất nền tảng |
| 05 | Render mock có MP4 xem trước; FFmpeg production | Mock hoàn tất, production cần hạ tầng |

Mặc định hệ thống chạy `mock` để không tiêu tiền. Khi cấu hình Google Cloud, factory trong `lib/veo-provider.ts` chuyển sang API thật mà không thay đổi giao diện hay route.

## Kiến trúc

```mermaid
flowchart LR
  U[Người dùng] --> S[SceneFlow Studio]
  S --> P[Prompt compiler]
  P --> B[Story Bible + storyboard]
  B --> Q[Hàng đợi cảnh]
  Q --> V[Veo provider]
  V --> C[QC + frame cuối]
  C -->|frame neo| Q
  C --> R[FFmpeg renderer]
  R --> O[Video 1080p hoàn chỉnh]
  S <--> D[(D1)]
  S <--> M[(R2)]
```

Điểm quan trọng của continuity: cảnh `N + 1` không được gửi đi trước khi cảnh `N` đạt QC. Frame cuối của cảnh `N` trở thành frame mở đầu của cảnh kế tiếp; Story Bible tiếp tục khóa nhân vật, sản phẩm, bối cảnh, ánh sáng và phong cách.

## Veo 3.1 Lite

SceneFlow ánh xạ lựa chọn `veo-3.1-lite` sang model API chính thức `veo-3.1-lite-generate-001`. Lite hỗ trợ 4, 6 hoặc 8 giây, 9:16 và 16:9, 720p/1080p, first/last-frame và âm thanh. Lite hiện là Preview và dùng fixed quota hoặc provisioned throughput; nhãn “Lower Priority” trên một số website bên thứ ba là cách họ xếp hàng nội bộ, không phải tham số của Vertex AI.

Tài liệu chính thức:

- [Veo 3.1 model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate)
- [Veo text-to-video REST API](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/generate-videos-from-text)
- [First/last frame workflow](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-first-and-last-frames)

## Chạy cục bộ

Yêu cầu Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Kiểm tra bản build:

```bash
npm run build
npm test
npm run verify
npm run start
```

`npm run start` dùng output của `npm run build` gần nhất. Trên Windows, `dev`, `build` và `start` đều đặt biến môi trường qua `cross-env`; bản production-like chạy bằng Wrangler để các binding `cloudflare:workers` hoạt động đúng. State cục bộ của Wrangler được lưu ở `.wrangler/state`, ngoài `dist`, nên build kế tiếp không bị `EBUSY` khi xóa output cũ. Hãy dừng server đang chạy bằng `Ctrl+C` trước khi build lại. Ở chế độ mặc định, pipeline mock tạo tuần tự bốn cảnh, khóa frame nối, lập manifest ghép và trả về một MP4 xem trước mà không cần Cloud Run hay Google Cloud.

## Bật Veo thật

Thiết lập secret ở môi trường server, không đưa vào mã client hoặc commit Git:

```dotenv
VEO_PROVIDER=google
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-central1
VEO_OUTPUT_GCS_URI=gs://your-private-bucket/sceneflow
GOOGLE_SERVICE_ACCOUNT_EMAIL=sceneflow@your-project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Có thể dùng `GOOGLE_ACCESS_TOKEN` ngắn hạn trong môi trường phát triển. Production nên dùng service account tối thiểu quyền, bucket GCS riêng và secret manager.

Renderer FFmpeg đã nằm trong `services/renderer` và có Dockerfile để triển khai Cloud Run. Khi bật renderer, thêm:

```dotenv
RENDER_SERVICE_URL=https://your-renderer.run.app
RENDER_SERVICE_SECRET=at-least-32-random-bytes
RENDER_OUTPUT_GCS_URI=gs://your-private-bucket/sceneflow-rendered
```

Xem hướng dẫn và hợp đồng API chi tiết tại `services/renderer/README.md`.

Model mapping:

| SceneFlow | Vertex AI model ID |
| --- | --- |
| Lite | `veo-3.1-lite-generate-001` |
| Fast | `veo-3.1-fast-generate-001` |
| Standard | `veo-3.1-generate-001` |

## Dữ liệu và bảo mật

- `.openai/hosting.json` khai báo D1 binding `DB` và R2 binding `MEDIA`.
- D1 tự khởi tạo schema idempotent ở request đầu tiên; migration chuẩn nằm trong `drizzle/0000_sceneflow_initial.sql`.
- Mọi route ghi dữ liệu yêu cầu Sign in with ChatGPT.
- Project, scene, job và asset luôn được kiểm tra theo email chủ sở hữu ở server.
- Ảnh chỉ nhận JPG/PNG/WebP tối đa 20 MB; file được lưu bằng object key ngẫu nhiên, không dùng tên file làm đường dẫn.
- Credit được ghi theo sổ cái append-only; API kiểm tra số dư trước khi gửi job.

## API chính

- `POST /api/prompts/optimize` — cấu trúc prompt, tách giả định và câu hỏi cần xác nhận.
- `GET|POST /api/projects` — danh sách/tạo project thuộc người dùng.
- `POST /api/assets` — tải ảnh tham chiếu vào R2.
- `POST /api/projects/:id/storyboard` — tạo chuỗi cảnh và dependency.
- `POST /api/scenes/:id/generate` — gửi cảnh đủ điều kiện vào provider.
- `GET /api/jobs/:id` — polling job mock hoặc Vertex AI.
- `POST /api/projects/:id/render` — tạo render manifest sau khi mọi cảnh hoàn tất.
- `GET /api/renders/:id/media` — mở MP4 mock hoặc stream video GCS riêng tư, hỗ trợ HTTP Range.
- `GET /api/credits` — số dư credit hiện tại.

## Để chạy 100 video/ngày

Ngoài mã nguồn, production cần quota Veo được Google phê duyệt, ngân sách/credit policy, hàng đợi có rate limit, dead-letter queue, theo dõi chi phí, cảnh báo lỗi, FFmpeg service có autoscaling và chính sách lưu/xóa media. Không nên cam kết 100 video/ngày chỉ dựa trên lựa chọn “Lower Priority”; năng lực thực tế phụ thuộc quota theo model, số cảnh mỗi video và tỷ lệ phải tạo lại sau QC.
