# Lunar Landing Site Navigator

同一個網頁有三個分頁，介面使用英文。

| 分頁 | 功能 |
| --- | --- |
| Landing planner | 旋轉月面地形、查看太陽和地球的高度與遮擋、播放 30 天預報、比較 14 天著陸情境、搜尋著陸日期、匯出 CSV |
| Orbit simulator | 播放太陽、地球與月球的位置，切換全景和地月近景，查看三組距離與月球的瞬時日心離心率 |
| Plane geometry | 輸入 A、B、C 三點，計算面積、內心與朝正 Y 方向的單位法向量，並旋轉預覽 |

## 本機啟動

安裝 Python 3.12 和 Pipenv。解壓縮後，在包含 `Pipfile` 的資料夾開啟 Terminal，再執行。

```sh
pipenv --python 3.12
pipenv sync
pipenv run start
```

瀏覽器開啟 [http://127.0.0.1:8000](http://127.0.0.1:8000)。終端機按 `Control+C` 停止。網頁已附所需的星曆區塊、地形和圖像，啟動後可離線使用。

## 操作

- **Landing planner** 先選地點和 UTC 日期，按 **Apply**。時間軸以選定的著陸時間為起點。點圖表也可以移動播放位置。按 **Lock as scenario A** 後，換日期、地點或模型設定即可比較。
- **Find best date** 以目前地點和模型設定，從所選日期起向後搜尋最多 30 天。排名使用 14 天內太陽圓面可見比例、地球可見時間及最長陰影，並在陰影超過電池耐久時間時扣分。
- **3D 視圖** 用滑鼠或觸控拖曳旋轉。滑鼠滾輪縮放。鍵盤聚焦到視圖後，可用方向鍵旋轉、`+` 和 `-` 縮放。
- **日期範圍** 著陸時間可選 1900-01-01 到 2049-11-01。軌道時間可選 1550-01-01 到 2550-12-31 00:00。介面上的日期與時間皆為 UTC。

## 更新資料

```sh
pipenv run build-data
```

首次重建會下載 `de421.bsp` 與 `de440.bsp`（合計約 131 MiB）到 `kernels/`。若手邊已有這兩個檔案，可以放進 `kernels/` 再重建。修改 `kernels/terrain_profiles.json` 後，也用同一指令更新網頁資料。靜態主機的網站根目錄應指向 `dist/`，並包含整個資料夾的內容。

## 計算與資料

- `build_data.py` 用 Skyfield 讀取 JPL 星曆。地平線每 6 小時取樣一次月心表觀向量，在月球固定座標系插值後換算成著陸點的仰角與方位角。軌道每天對 DE440 的位置和速度取樣，瀏覽器用 Hermite 插值得出中間時刻。距離和轉換時刻是近似值。
- 網頁使用上傳資料中的 40 × 40 地形網格和 360 點地平線。地形起伏、三個天體的大小和地月視覺距離都有比例調整。儀表上的角度和距離使用模型算出的數值。
- 參考地點用平坦地平線。自訂點距離已有地形的點在 10 km 內時會借用該點的地平線，並標為 **Borrowed**。當資料中的 −2° 截斷值影響可見性判讀時，頁面會標示不確定。Mast 高度修正使用已知的山脊距離，缺少時使用介面中可調整的假設值。
- 太陽可見性使用太陽圓面的上緣，地球可見性使用地球中心。預報以一小時取樣，較短的遮擋可能略過。電池耐久度及 14 天窗口評分為可調整的規劃模型。

星曆與月球定向資料來自 NASA JPL 和 NAIF。軌道球體紋理使用 NASA SVS 的 CGI Moon Kit 和 NASA Blue Marble Next Generation。地形網格由使用者提供。

[NASA JPL ephemerides](https://ssd.jpl.nasa.gov/planets/eph_export.html) · [NAIF kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/) · [NASA CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) · [NASA Blue Marble](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/)
