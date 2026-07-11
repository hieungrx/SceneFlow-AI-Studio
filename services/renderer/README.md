# SceneFlow Renderer (Cloud Run)

Dịch vụ Node.js không dùng framework, chạy `ffmpeg`/`ffprobe` để:

- `POST /extract-last-frame`: lấy frame cuối của một clip để làm ảnh tham chiếu continuity cho cảnh tiếp theo.
- `POST /render`: chuẩn hóa và ghép tối đa 100 clip thành MP4; hỗ trợ cut hoặc crossfade cả hình lẫn âm thanh.

File đầu vào được tải về thư mục tạm, xử lý xong rồi tải kết quả lên một signed HTTPS upload URL hoặc trực tiếp tới `outputGcsUri`. Với GCS, renderer lấy OAuth access token từ metadata server của Cloud Run. Dịch vụ không trả video dạng base64 và không lưu file lâu dài.

## Bảo mật

Mọi endpoint xử lý media yêu cầu một trong hai header:

```text
X-Renderer-Token: <RENDERER_AUTH_TOKEN>
```

hoặc:

```text
Authorization: Bearer <RENDERER_AUTH_TOKEN>
```

`X-Renderer-Token` phù hợp nhất khi Cloud Run cũng bật IAM, vì header `Authorization` khi đó dành cho Google identity token. `GET /healthz` không cần token và không nhận dữ liệu người dùng.

Dịch vụ chỉ chấp nhận:

- HTTPS công khai, không có username/password và không trỏ trực tiếp tới IP riêng/loopback.
- URI GCS đúng dạng `gs://bucket/object`. Renderer dùng Google Cloud Storage JSON API và lấy OAuth token từ Cloud Run metadata server. Service account của Cloud Run phải có quyền đọc object nguồn và tạo object đầu ra.

`file://`, đường dẫn local, `http://`, `ftp://` và URI thiếu object đều bị từ chối. Signed URL chỉ nên sống vài phút. Không đưa signed URL hoặc token vào log.

## Chạy local bằng Docker

```bash
docker build -t sceneflow-renderer ./services/renderer
docker run --rm -p 8080:8080 \
  -e RENDERER_AUTH_TOKEN="replace-with-at-least-32-random-bytes" \
  sceneflow-renderer
```

Để thử đọc hoặc ghi `gs://` ngoài Cloud Run, có thể truyền access token ngắn hạn qua `GOOGLE_OAUTH_ACCESS_TOKEN`. Biến này chỉ dành cho phát triển; production dùng service account metadata.

## API: lấy frame cuối

```json
{
  "videoUri": "gs://my-veo-output/project-1/scene-01.mp4",
  "format": "jpeg",
  "outputGcsUri": "gs://my-render-output/project-1/frame-01.jpg"
}
```

`videoUrl` vẫn được nhận như alias của `videoUri`. `format` là `jpeg` hoặc `png`. Mỗi request phải truyền đúng một trong hai đích đầu ra:

- `outputGcsUri`: URI nghiêm ngặt dạng `gs://bucket/object`; renderer tải lên bằng OAuth của service account và chỉ tạo object mới, không ghi đè object đã tồn tại.
- `outputUpload`: signed HTTPS URL, method `PUT`, và các header tùy chọn cần thiết cho chữ ký.

Truyền cả hai hoặc không truyền đích nào sẽ trả `400 invalid_output_destination`.

Phản hồi thành công:

```json
{
  "ok": true,
  "requestId": "43bb14e9-8af0-4a96-b20b-6bfe64d99525",
  "operation": "extract-last-frame",
  "outputUri": "gs://my-render-output/project-1/frame-01.jpg",
  "source": { "durationSeconds": 8.008 },
  "output": {
    "contentType": "image/jpeg",
    "bytes": 184202,
    "width": 1080,
    "height": 1920
  }
}
```

Khi dùng `outputGcsUri`, phản hồi thành công có thêm `outputUri` ở cấp cao nhất. Với signed `outputUpload`, trường này được bỏ qua để không phản chiếu URL có chữ ký.

## API: ghép video

```json
{
  "clips": [
    { "uri": "gs://my-veo-output/project-1/scene-01.mp4" },
    { "uri": "https://signed-download.example/scene-02.mp4?..." },
    { "uri": "gs://my-veo-output/project-1/scene-03.mp4" }
  ],
  "width": 1080,
  "height": 1920,
  "fps": 24,
  "includeAudio": true,
  "transition": {
    "type": "fade",
    "durationSeconds": 0.2
  },
  "crf": 20,
  "preset": "veryfast",
  "outputUpload": {
    "url": "https://signed-upload.example/final.mp4?...",
    "method": "PUT"
  }
}
```

Một clip có thể viết gọn bằng chuỗi URI. `transition.type` nhận `cut`, `fade`, `fadeblack`, `fadewhite`, `dissolve`, `wipeleft`, `wiperight`, `slideleft`, `slideright`. Kích thước phải là số chẵn; renderer scale theo contain và thêm nền đen nếu tỷ lệ nguồn khác tỷ lệ đích.

Phản hồi thành công chỉ chứa metadata; signed URL không bị phản chiếu lại. Nếu dùng GCS, `outputUri` ở cấp cao nhất cho biết object đã ghi:

```json
{
  "ok": true,
  "requestId": "944cc9e8-514f-453f-b9dd-dcc4cb8d7fd2",
  "operation": "render",
  "clips": 3,
  "transition": { "type": "fade", "durationSeconds": 0.2 },
  "output": {
    "contentType": "video/mp4",
    "bytes": 11832044,
    "durationSeconds": 23.624,
    "width": 1080,
    "height": 1920,
    "fps": 24,
    "hasAudio": true
  }
}
```

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
| --- | ---: | --- |
| `RENDERER_AUTH_TOKEN` | bắt buộc | Shared secret; nên là ít nhất 32 byte ngẫu nhiên |
| `PORT` | `8080` | Cổng HTTP Cloud Run |
| `MAX_CONCURRENT_JOBS` | `2` | Số job đồng thời trong một instance |
| `MAX_CLIPS` | `100` | Số clip tối đa mỗi render |
| `MAX_INPUT_BYTES` | `536870912` | Giới hạn từng file nguồn (512 MiB) |
| `MAX_TOTAL_INPUT_BYTES` | `4294967296` | Tổng nguồn mỗi job (4 GiB) |
| `FFMPEG_TIMEOUT_MS` | `900000` | Timeout cho mỗi lệnh FFmpeg/ffprobe |
| `DOWNLOAD_TIMEOUT_MS` | `120000` | Timeout tải xuống/tải lên |
| `GOOGLE_OAUTH_ACCESS_TOKEN` | trống | Chỉ dùng để thử đọc/ghi `gs://` local |

## Triển khai Cloud Run

Tạo secret và service account riêng, sau đó cấp quyền đọc bucket chứa output của Veo và quyền tạo object trong bucket kết quả:

```bash
gcloud iam service-accounts create sceneflow-renderer
gcloud storage buckets add-iam-policy-binding gs://MY_VEO_BUCKET \
  --member="serviceAccount:sceneflow-renderer@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
gcloud storage buckets add-iam-policy-binding gs://MY_RENDER_OUTPUT_BUCKET \
  --member="serviceAccount:sceneflow-renderer@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectCreator"
gcloud secrets create renderer-auth-token --data-file=-
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/sceneflow/renderer ./services/renderer
gcloud run deploy sceneflow-renderer \
  --image REGION-docker.pkg.dev/PROJECT_ID/sceneflow/renderer \
  --region REGION \
  --service-account sceneflow-renderer@PROJECT_ID.iam.gserviceaccount.com \
  --set-secrets RENDERER_AUTH_TOKEN=renderer-auth-token:latest \
  --cpu 4 --memory 8Gi --timeout 3600 --concurrency 2 \
  --no-allow-unauthenticated
```

Nếu caller không thể tạo Google identity token (ví dụ Worker ở edge), có thể dùng `--allow-unauthenticated`; các endpoint media vẫn đóng bằng `X-Renderer-Token`. Với backend chạy trên Google Cloud, giữ `--no-allow-unauthenticated`, gửi Google ID token qua `Authorization` và shared secret qua `X-Renderer-Token`.

Cloud Run cần đủ ephemeral disk cho tổng input cộng output của các job đồng thời. Khi render hàng loạt, đặt Cloud Tasks/Pub/Sub phía trước renderer, dùng idempotency ở backend và không retry mù các lỗi `400/413/422`.
