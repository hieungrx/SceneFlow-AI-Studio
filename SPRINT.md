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

**Trạng thái:** Đang thực hiện. Gate local 2.4A PASS; verification trên deployment mới còn chờ publish. 2.4B chưa bắt đầu.

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

#### Gate deployment còn lại

- Publish một Sites version chứa 2.4A và xác nhận unauthenticated, logout/hết phiên, owner/non-owner trên deployment.
- Xác nhận request tự gắn identity header hoặc đường gọi origin trực tiếp không thể bypass Sites dispatcher.
- Việc publish/commit/push chưa được thực hiện trong implementation local này.

### Bước tiếp theo

Checkpoint 2.4B: Cloud Run/GCS staging, secret/IAM tối thiểu quyền và renderer canary trước real Veo E2E.
