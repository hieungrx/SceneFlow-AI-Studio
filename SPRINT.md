# SPRINT.md — SceneFlow AI Studio

## Checkpoint 2.3 — Manual QC và private scene media

**Trạng thái:** Hoàn tất · Gate Re-Review PASS

**Ngày chốt baseline:** 2026-07-17

### Mục tiêu

Cho phép người dùng xem đầu ra từng cảnh, tự duyệt hoặc từ chối QC và tiếp tục pipeline mà không phá invariant continuity: cảnh sau chỉ được tạo khi cảnh trước đã được duyệt và có frame cuối hợp lệ.

### Phạm vi đã hoàn thành

- UI từng cảnh có video preview, hành động duyệt/từ chối/tạo lại và lý do khóa rõ ràng.
- Nút duyệt chỉ hoạt động khi có cả video đầu ra và continuity frame.
- Pipeline dừng ở manual QC hoặc generation đang chạy, không gửi thêm scene ngoài ý muốn.
- Regeneration giữ đúng dependency chain và khóa các cảnh downstream.
- Scene media kiểm tra auth và ownership trước khi trả dữ liệu; mock media vẫn redirect `307`.
- GCS scene media chỉ nhận một byte range hợp lệ, khóa ma trận `200`/`206`/`416`, chỉ stream `video/mp4` và không lộ body lỗi upstream.
- README mô tả endpoint và contract scene media.

### Bằng chứng Gate

- Targeted contract suite: **52/52 PASS**.
- `npm run verify`: lint sạch, production build thành công, **141/141 test/subtest PASS** và renderer syntax hợp lệ.
- Runtime integration xác nhận unauthenticated `401`, non-owner `404`, mock redirect `307` kể cả với multi-range malformed, và MP4 mock đọc được.
- Route-level spy xác nhận invalid GCS Range trả local `416` với **0 lần gọi upstream**.
- Independent re-review: UI policy PASS; GCS contract PASS; không còn blocker Checkpoint 2.3.

### Ranh giới được giữ nguyên

- Không đổi schema/migration D1.
- Không đổi Veo provider selection hoặc contract Studio ↔ renderer.
- Không đổi credit ledger, ownership pattern hoặc cách ghi R2.
- Không triển khai hay thay đổi tài nguyên Google Cloud.

### Ngoài phạm vi baseline

- Xác minh và khóa trust boundary của auth header tại Worker origin.
- Áp contract Range/MIME an toàn cho final-render media route.
- Magic-byte, request cap, quota và orphan cleanup cho asset upload.
- Cloud Run/GCS staging, real Veo E2E, production queue, observability và media lifecycle.

## Checkpoint 2.4 — Production Trust Boundary & E2E Readiness

**Trạng thái:** Đang thực hiện. Gate local 2.4A PASS và production đã được publish; edge probes unauthenticated/header-spoof PASS. Renderer Cloud Run/GCS staging 2.4B đã deploy và canary PASS. Kiểm tra SIWC tương tác bằng phiên owner/non-owner và logout/session-expiry, cùng real Veo E2E, còn chờ.

Thứ tự đề xuất: auth origin → final-render media → asset ingestion → Cloud Run/GCS staging → real Veo E2E → queue/observability/lifecycle.

### Checkpoint 2.4A — Security gate

**Ngày hoàn tất implementation local:** 2026-07-18

#### Phạm vi đã hoàn thành

- Chốt trust boundary dùng Sites dispatcher sở hữu SIWC, giữ `access_mode=custom` và không thêm auth stack riêng trong SceneFlow.
- Ghi rõ invariant không được để raw Worker origin trở thành đường public bypass dispatcher.
- Final-render media dùng cùng helper/chính sách strict Range, MIME và safe upstream error như scene media.
- Asset upload áp hard request cap trước hoặc trong khi parse multipart bằng counting stream, giữ giới hạn 20 MiB/file và xác minh magic bytes JPG/PNG/WebP.
- MIME và extension lưu trữ lấy từ file signature đã phát hiện, không lấy từ filename.
- Nếu R2 put thành công nhưng ghi metadata thất bại, route thử xóa bù đúng object key vừa tạo; lỗi cleanup không lộ chi tiết nội bộ.
- Quota cộng dồn theo user/project được hoãn sang phase lifecycle/capacity; không đổi schema trong 2.4A.

#### Bằng chứng Gate local

- Targeted suites mới: **39/39 test/subtest PASS** cho final-render media, asset validation, bounded multipart và asset route failure compensation.
- `npm run verify`: lint sạch, production build thành công, **180/180 test/subtest PASS** và renderer syntax hợp lệ.
- Invalid hoặc multi-range final-render trả local `416` với 0 lần gọi GCS; upstream status/MIME/header sai được thu gọn thành safe `502`.
- Request upload quá cap hoặc MIME/signature sai không chạm R2; DB failure sau R2 put gọi exact-key delete.
- Không đổi schema/migration D1, provider selection, renderer contract, credit ledger hoặc continuity chain.

#### Kết quả publish và gate deployment

- Production Sites đã publish ngày 2026-07-18 từ đúng commit 2.4A; access policy vẫn là `custom`, chỉ một user được phép và không có group.
- Request API chưa đăng nhập trả `403`; request tự gắn `oai-authenticated-user-*` cũng trả `403`, nên spoofed identity header không bypass dispatcher public.
- Phiên browser automation không thuộc allowlist và nhận `Access Denied`, đúng với custom access policy nhưng không thay thế kiểm tra bằng phiên owner thật.
- Còn phải xác nhận owner flow, non-owner flow, logout/session-expiry và direct-origin reachability bằng phiên/môi trường triển khai phù hợp trước khi coi toàn bộ deployment gate đã đóng.

### Checkpoint 2.4B — Cloud Run/GCS renderer staging

**Ngày hoàn tất staging canary:** 2026-07-19

#### Phạm vi đã hoàn thành

- Dùng project staging `project-c23ce61c-905d-4b2d-8e1` (`194278159531`) và region `us-central1`; không tạo project, bucket hoặc service trùng.
- Nâng renderer container từ Node.js 20 EOL lên Node.js 22 và chép đủ `extraction-operation.mjs` vào image.
- Thêm test bảo đảm mọi local ESM import của `server.mjs` đều có trong Dockerfile và container tiếp tục chạy bằng non-root user.
- Deploy revision `sceneflow-renderer-staging-2-4b-01` từ image digest `sha256:b9c9afaf3253a6875af2c2ddc364e2d5d91f93b941accdbda7ab8f11f17647a5`; canary 0% traffic PASS trước khi promote 100%.
- Giữ cấu hình staging có giới hạn: gen2, 2 CPU, 4 GiB, concurrency 1, min instance 0, max instance 1, tối đa 4 clip và 256 MiB tổng input.
- Bucket bật uniform bucket-level access, public access prevention, soft delete 0 và lifecycle tự xóa `input/` sau 3 ngày, `output/`/`failed/` sau 7 ngày.
- Runtime service account chỉ đọc media staging và có `roles/storage.objectUser` kèm IAM condition giới hạn write/update dưới `output/`; secret version 2 được pin qua Secret Manager.

#### Bằng chứng Gate

- Container smoke test: health `200`, thiếu token `401`, token đúng đi qua auth, Node `22.23.1`, FFmpeg `5.1.9`, extraction module có trong image.
- Render thật ghép 4 clip với fade thành MP4 H.264 `1080×1920`, `yuv420p`, 24 fps; AAC 48 kHz stereo; duration `31.458333s`.
- Extraction v2 lần đầu trả `201 created`, cùng binding trả `200 replayed` với cùng generation, binding khác trả `409 idempotency_conflict`.
- GCS output ẩn danh trả `403`; authenticated byte range trả `206` đúng 32 byte và MIME `video/mp4`.
- Log revision chỉ ghi các request/status dự kiến, không ghi renderer token.
- `npm run verify`: lint sạch, production build thành công, **182/182 test/subtest PASS** và renderer syntax hợp lệ.

#### Ranh giới và việc còn lại

- Studio/Sites vẫn chạy mock và chưa được cấu hình gọi renderer staging; tránh gửi URI `mock://` tới Cloud Run.
- Cloud Run staging dùng public invoker ở lớp platform vì caller hiện chưa mint Google ID token; mọi endpoint xử lý media vẫn bắt buộc `X-Renderer-Token`, và max instance 1 giới hạn rủi ro chi phí/DoS.
- `/extract-last-frame` v2 có durable idempotency; `/render` chưa replay idempotent khi output đã tồn tại và chưa có production retry queue.
- Real Veo E2E, Worker credential đọc GCS, monitoring/alerting đầy đủ và production capacity test chưa thuộc gate này.

### Bước tiếp theo

Hoàn tất các kiểm tra SIWC tương tác còn lại, sau đó chạy real Veo E2E trên staging: tạo một cảnh thật, extraction continuity, manual QC, render cuối và private playback. Chỉ nối `RENDER_SERVICE_*` vào Studio khi scene source đã là `gs://` hoặc HTTPS hợp lệ.
