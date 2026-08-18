# Deploy World

Công cụ kéo thả: người dùng đưa source HTML vào, công cụ đẩy lên hosting và trả
về một URL chạy được.

Hỗ trợ hai nhà cung cấp. Chọn ngay trên giao diện.

| | Netlify (mặc định) | Render |
|---|---|---|
| Cần git repo? | Không | **Có** — bắt buộc |
| Số khoá phải nhập | 1 (Netlify token) | 2 (GitHub token + Render API key) |
| Source đi qua đâu | Thẳng lên Netlify | Commit lên GitHub trước |
| Repo phải public? | Không có repo | Có, trừ khi cài Render GitHub App |
| Deploy lần hai | Chỉ upload file đã đổi | Commit lại toàn bộ |

Nếu không có lý do đặc biệt phải dùng Render, chọn Netlify — nó ít bước hơn và
không kéo GitHub vào cuộc.

## Danh sách site đã deploy

Giao diện có mục **Site đã deploy** liệt kê toàn bộ site trong tài khoản của nhà
cung cấp đang chọn: tên, URL bấm được, trạng thái, thời điểm deploy gần nhất và
link tới dashboard. Danh sách tự tải khi đã có khoá, tự làm mới sau mỗi lần deploy
thành công, và có nút Tải lại.

Mỗi dòng có nhãn **public** hoặc **private**. Nhãn này không lấy từ trạng thái do
nhà cung cấp báo — `ready` chỉ nói deploy đã xong, không nói khách xem được. Server
tự mở từng URL **không kèm token**, đúng như một người lạ, rồi báo lại kết quả thật.
Không kiểm tra được (mạng lỗi, quá hạn) thì hiện *chưa rõ* chứ không đoán bừa.

Dữ liệu lấy trực tiếp từ `GET /sites` (Netlify) và `GET /services?type=static_site`
(Render) — công cụ không tự lưu danh sách nào, nên site bạn xoá trên dashboard sẽ
biến mất khỏi đây ngay lần tải lại kế tiếp.

## Vì sao Render lại rắc rối hơn

Render **không có API upload file**. Endpoint `POST /v1/services` bắt buộc có
trường `repo` trỏ tới một git repository. Nên với Render, công cụ phải làm cầu nối:

```
Kéo thả  ->  commit lên GitHub  ->  Render Static Site trỏ vào repo đó
```

Netlify thì nhận file trực tiếp, nên không cần khâu trung gian nào:

```
Kéo thả  ->  khai báo sha1 các file  ->  upload file Netlify chưa có  ->  xong
```

Netlify chỉ yêu cầu upload những file mà nó chưa có, nên deploy lần thứ hai
gần như tức thì.

## Cấu trúc

```
server/
├── index.js            Express + định tuyến theo nhà cung cấp
└── lib/
    ├── validate.js     chặn path traversal, lọc file, bóc thư mục bọc ngoài
    ├── netlify.js      digest sha1 -> upload file thiếu -> chờ "ready"
    ├── github.js       Git Data API: blob -> tree -> commit -> ref
    └── render.js       Render REST API: owner, service, deploy, trạng thái
web/
├── index.html          giao diện 4 bước
├── app.js              kéo thả đệ quy cả thư mục, đọc file, theo dõi tiến trình
└── style.css
render.yaml             để deploy chính công cụ này lên Render
```

## Chạy ở máy

```bash
npm install
npm start          # http://localhost:3000
# hoặc npm run dev để tự restart khi sửa code
```

Cần Node >= 18 (dùng `fetch` có sẵn).

## Khoá API

| Khoá | Lấy ở đâu | Quyền cần |
|---|---|---|
| Netlify token | https://app.netlify.com/user/applications#personal-access-tokens | — |
| GitHub token | https://github.com/settings/tokens | scope `repo` (classic), hoặc fine-grained với `Contents: RW` + `Administration: RW` |
| Render API key | https://dashboard.render.com/settings#api-keys | — |

Chỉ cần khoá của nhà cung cấp bạn định dùng. Hai cách cấp khoá:

- **Người dùng tự nhập trên giao diện** — site vào tài khoản của chính họ. Khoá
  gửi kèm từng request, server không lưu; trình duyệt nhớ hộ ở localStorage.
- **Đặt sẵn trên server** — copy `.env.example` thành `.env` rồi điền.

Request có khoá thì ưu tiên khoá của request, không có thì rơi về biến môi trường.

## Deploy chính công cụ này

Đây là Node app nên phải chạy dạng **Web Service**, không phải static site:

1. Push repo lên GitHub.
2. Render Dashboard → **New** → **Blueprint** → chọn repo (đọc `render.yaml`).
3. Render hỏi giá trị cho `NETLIFY_TOKEN`, `GITHUB_TOKEN` và `RENDER_API_KEY` —
   để trống hết nếu muốn người dùng tự nhập khoá. Chỉ dùng Netlify thì một
   `NETLIFY_TOKEN` là đủ.

Free tier của Web Service **ngủ sau 15 phút** không có request, lần gọi kế tiếp
mất khoảng 30 giây để dậy.

## Giới hạn file

Đặt trong `server/lib/validate.js`:

- Tối đa **200 file**, mỗi file **5MB**, tổng **25MB**
- Nhận mọi loại file source (ts, jsx, vue, scss, yaml, file không đuôi...).
  Dùng danh sách đen chứ không phải danh sách trắng, nên không âm thầm nuốt file.
- Chặn hẳn file bí mật (`.env`, `id_rsa`, `.pem`, `.key`...) và nhị phân thực thi,
  báo rõ đã chặn cái gì và vì sao
- Cần ít nhất một file HTML ở gốc. **Không bắt buộc tên `index.html`** — nếu
  thiếu, công cụ tự chọn trang chủ:
  - Đúng một trang → đổi tên trang đó thành `index.html`
  - Nhiều trang → nhân bản trang có tên quen thuộc (`home`, `main`, `default`,
    `trang-chu`...), không có thì lấy trang đầu theo bảng chữ cái. File gốc được
    giữ nguyên để link giữa các trang không gãy. Mọi trường hợp đều báo rõ ở phần
    tiến trình.
- Tự bỏ thư mục bọc ngoài khi kéo cả folder (`my-site/index.html` → `index.html`)
- Tự bỏ rác: `.git/`, `node_modules/`, `.DS_Store`, `.env`

## Trùng tên site

Tên site vừa là tên repo/service vừa là subdomain, nên gõ trùng tên một site đã có
nghĩa là deploy sẽ **thay toàn bộ nội dung** của site đó.

Công cụ không để chuyện đó xảy ra âm thầm. Có hai lớp:

1. **Báo sớm khi gõ** — giao diện đối chiếu tên đang gõ với danh sách site đã tải
   và hiện cảnh báo ngay dưới ô nhập, trước cả khi bạn bấm Deploy.
2. **Chặn ở server** — nếu tên trùng một site đang có nội dung mà chưa bật
   *"Ghi đè nếu trùng tên"*, request dừng lại trước khi upload bất kỳ file nào.

Lớp 2 mới là lớp bảo vệ thật; lớp 1 chỉ để bạn biết sớm. Danh sách phía client có
thể cũ hoặc chưa tải, nên không được tin nó để quyết định.

## Dùng Netlify: project private mặc định

Từ **28/07/2026** Netlify đặt mọi project mới ở chế độ **private** trên gói Free,
Personal và Pro. Deploy vẫn thành công, site vẫn có URL, nhưng người lạ mở link sẽ
thấy banner *"This project is private"* và không xem được nội dung.

Đặc tả OpenAPI công khai của Netlify chưa có field nào đổi được visibility, nên
công cụ **không tự bật public được**. Thay vào đó, sau khi deploy xong nó tự thử
truy cập site như người lạ (không kèm token) và báo rõ nếu site đang private.

Hai cách xử lý:

1. **Một lần cho tất cả** — Team settings → General → Visitor access →
   *Default project visibility* → **Public**. Từ đó mọi site công cụ tạo đều public.
2. **Từng site** — mở dashboard, bấm **Make public**, hoặc Project configuration →
   General → Visitor access → Project visibility → Public.

Cách 1 đáng làm nếu bạn định dùng công cụ này thường xuyên.

Riêng bản thân deploy thì luôn là production: công cụ truyền tường minh
`draft: false` khi gọi `POST /sites/{id}/deploys`.

## Dùng Render: chuyện repo public

Render trả lỗi này khi repo đang private:

```
Render 400: passed in repository URL is invalid or unfetchable
```

Công cụ tạo repo mới ở chế độ public. Nhưng nếu bạn đã có sẵn repo private trùng
tên, nó sẽ phát hiện và dừng lại kèm hướng dẫn thay vì đâm vào lỗi khó hiểu.

Bốn cách xử lý:

1. **Chuyển sang Netlify** — không có repo thì không có vấn đề này. Gọn nhất.
2. **Cài Render GitHub App** tại `github.com/apps/render/installations/new` →
   Render đọc được repo private. Đây là cách duy nhất giữ được source riêng tư
   mà vẫn dùng Render. Phải làm tay một lần trên trình duyệt, không tự động hoá
   qua API được.
3. **Tick "Chuyển repo sang public"** trên giao diện. Lưu ý đây là công khai toàn
   bộ source trong repo đó ra Internet và không tự hoàn tác được.
4. **Đổi tên site** → công cụ tạo repo public mới, không đụng repo cũ.

Kiểm tra nhanh một repo có public hay không:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/OWNER/REPO
# 200 = public, 404 = private (hoặc không tồn tại)
```

## Dùng Render: ghi đè repo có sẵn

Mỗi lần deploy tạo một cây file hoàn toàn mới (cố ý không dùng `base_tree`), nên
file bạn đã xoá ở máy cũng biến mất khỏi site. Hệ quả: nếu trỏ vào một repo đang
có nội dung khác, nội dung đó bị thay sạch trên nhánh mặc định.

Vì vậy công cụ **không tự ghi đè**. Gặp repo có sẵn và đang có commit, nó dừng
lại và báo. Muốn ghi đè thì tick "Ghi đè repo cùng tên đã có nội dung".

Lỡ ghi đè nhầm vẫn khôi phục được, vì commit mới lấy commit cũ làm parent:

```bash
git clone https://github.com/OWNER/REPO && cd REPO
git reset --hard HEAD~1
git push --force
```

## Hạn chế còn lại

- **Chưa hỗ trợ file .zip** — chỉ nhận kéo thả thư mục hoặc nhiều file rời.
- **Chưa có xác thực người dùng.** Ai vào được URL của công cụ cũng deploy được.
  Nếu đặt khoá mặc định trên server rồi công khai URL, người lạ có thể tạo site
  trong tài khoản của bạn.
- **Tên site Netlify là duy nhất toàn cầu** vì nó thành subdomain `*.netlify.app`.
  Trùng tên với người khác thì phải đổi tên.

## Trạng thái kiểm thử

Đã kiểm thử ở máy: server khởi động, giao diện phục vụ đúng, và các đường lỗi của
cả hai nhà cung cấp — thiếu khoá, thiếu `index.html`, path traversal, provider
không hợp lệ, token Netlify sai (`Netlify 401: Access Denied`), token GitHub sai
(`GitHub 401: Bad credentials`).

**Chưa có lần deploy nào chạy trọn vẹn tới trạng thái live** vì cần khoá thật.
Nhánh Render đã chạy thật một lần và dừng ở lỗi repo private — nguyên nhân đã xác
định và xử lý. Nhánh Netlify chưa chạy thật lần nào; điểm cần xác nhận đầu tiên
là bước `PUT /deploys/{id}/files/{path}` với đường dẫn có thư mục con.
