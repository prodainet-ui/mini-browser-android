package kz.marzhan.browser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    static final String START_URL = "file:///android_asset/start/start.html";
    static final String SEARCH = "https://www.google.com/search?q=";
    static final int FILE_CHOOSER_REQUEST = 1;

    static final class Tab {
        WebView view;
        String title = "Новая вкладка";
        Bitmap favicon;
        int progress = 100;
        String pendingUrl;   // вкладка из прошлой сессии, загрузится при открытии
        boolean closed;
    }

    private final List<Tab> tabs = new ArrayList<>();
    private Tab current;
    private Store store;

    private EditText address;
    private ProgressBar progress;
    private FrameLayout webContainer;
    private LinearLayout tabsOverlay;
    private LinearLayout tabsList;
    private TextView tabsTitle;
    private TextView tabCount;
    private ImageButton backBtn, forwardBtn, reloadBtn;
    private View findBar;
    private EditText findInput;
    private TextView findCount;

    private ValueCallback<Uri[]> fileCallback;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private String defaultUserAgent;

    // ───────────────────────────── Запуск ─────────────────────────────

    // ───── Тема оформления: подменяем ночной режим для окна приложения ─────

    @Override
    protected void attachBaseContext(Context base) {
        String theme = Store.theme(base);
        if ("system".equals(theme)) {
            super.attachBaseContext(base);
            return;
        }
        Configuration config = new Configuration(base.getResources().getConfiguration());
        config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                | ("dark".equals(theme) ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
        super.attachBaseContext(base.createConfigurationContext(config));
    }

    private boolean isDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    private boolean startedDark;

    /** Система сменила тему (например, вечером) — перестраиваем окно, если выбрано «Как в системе». */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (!"system".equals(Store.theme(this))) return;
        boolean dark = (newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (dark != startedDark) recreate();
    }

    private void chooseTheme() {
        String[] ids = {"system", "light", "dark"};
        String[] labels = {"Как в системе", "Светлая", "Тёмная"};
        int checked = java.util.Arrays.asList(ids).indexOf(Store.theme(this));
        new AlertDialog.Builder(this)
                .setTitle("Тема оформления")
                .setSingleChoiceItems(labels, Math.max(checked, 0), (d, which) -> {
                    d.dismiss();
                    if (ids[which].equals(Store.theme(this))) return;
                    store.setTheme(ids[which]);
                    recreate(); // вкладки сохранятся и откроются снова
                })
                .setNegativeButton("Отмена", null)
                .show();
    }

    private void toggleDarkenSites() {
        boolean on = !store.darkenSites();
        store.setDarkenSites(on);
        for (Tab t : tabs) applyDarkening(t.view);
        if (current != null && current.pendingUrl == null) current.view.reload();
        toast(on ? "Сайты будут затемняться в тёмной теме" : "Сайты отображаются как есть");
    }

    /** Android 13+: затемнять сайты без собственной тёмной версии. */
    private void applyDarkening(WebView wv) {
        if (Build.VERSION.SDK_INT >= 33) wv.getSettings().setAlgorithmicDarkeningAllowed(store.darkenSites());
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        startedDark = isDark();
        setContentView(R.layout.activity_main);
        store = new Store(this);

        address = findViewById(R.id.address);
        progress = findViewById(R.id.progress);
        webContainer = findViewById(R.id.webContainer);
        tabsOverlay = findViewById(R.id.tabsOverlay);
        tabsList = findViewById(R.id.tabsList);
        tabsTitle = findViewById(R.id.tabsTitle);
        tabCount = findViewById(R.id.tabCount);
        backBtn = findViewById(R.id.back);
        forwardBtn = findViewById(R.id.forward);
        reloadBtn = findViewById(R.id.reload);
        findBar = findViewById(R.id.findBar);
        findInput = findViewById(R.id.findInput);
        findCount = findViewById(R.id.findCount);

        address.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                navigate(address.getText().toString());
                return true;
            }
            return false;
        });
        address.setOnFocusChangeListener((v, hasFocus) -> {
            if (hasFocus) address.post(address::selectAll);
            else updateUi();
        });

        backBtn.setOnClickListener(v -> { if (current != null && current.view.canGoBack()) current.view.goBack(); });
        forwardBtn.setOnClickListener(v -> { if (current != null && current.view.canGoForward()) current.view.goForward(); });
        reloadBtn.setOnClickListener(v -> {
            if (current == null) return;
            if (current.progress < 100) current.view.stopLoading();
            else current.view.reload();
        });
        findViewById(R.id.home).setOnClickListener(v -> { if (current != null) load(current, START_URL); });
        findViewById(R.id.tabsButton).setOnClickListener(v -> showTabs());
        findViewById(R.id.menu).setOnClickListener(this::showMenu);
        findViewById(R.id.closeTabs).setOnClickListener(v -> hideTabs());
        findViewById(R.id.newTabFromList).setOnClickListener(v -> { hideTabs(); newTab(START_URL, true); });

        findInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) {
                if (current == null) return;
                if (s.length() == 0) { current.view.clearMatches(); findCount.setText(""); }
                else current.view.findAllAsync(s.toString());
            }
        });
        findViewById(R.id.findNext).setOnClickListener(v -> { if (current != null) current.view.findNext(true); });
        findViewById(R.id.findPrev).setOnClickListener(v -> { if (current != null) current.view.findNext(false); });
        findViewById(R.id.findClose).setOnClickListener(v -> closeFind());

        // Восстанавливаем вкладки прошлого сеанса
        List<String> saved = store.loadSession();
        if (saved.isEmpty()) {
            newTab(START_URL, true);
        } else {
            int active = Math.min(Math.max(store.sessionActive(), 0), saved.size() - 1);
            for (String saveUrl : saved) {
                String u = "start".equals(saveUrl) ? START_URL : saveUrl;
                Tab t = new Tab();
                t.view = createWebView(t);
                t.pendingUrl = u;
                if (!START_URL.equals(u)) t.title = u;
                tabs.add(t);
            }
            selectTab(tabs.get(active));
            updateTabCount();
        }
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** Ссылки, открытые из других приложений. */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String url = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            url = intent.getData().toString();
        } else if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null) url = toUrl(text);
        }
        if (url != null) {
            hideTabs();
            newTab(url, true);
        }
        intent.setAction(null); // не открывать повторно при пересоздании
    }

    @Override
    protected void onPause() {
        super.onPause();
        List<String> urls = new ArrayList<>();
        int active = 0;
        for (Tab t : tabs) {
            String u = t.pendingUrl != null ? t.pendingUrl : t.view.getUrl();
            if (u == null || u.isEmpty() || "about:blank".equals(u)) continue;
            if (t == current) active = urls.size();
            urls.add(isStart(u) ? "start" : u);
        }
        store.saveSession(urls, active);
        store.save();
        CookieManager.getInstance().flush();
    }

    // ───────────────────────────── Вкладки ─────────────────────────────

    private Tab newTab(String url, boolean select) {
        Tab tab = new Tab();
        tab.view = createWebView(tab);
        int index = current == null ? tabs.size() : tabs.indexOf(current) + 1;
        tabs.add(index, tab);
        if (url != null) load(tab, url);
        if (select || current == null) selectTab(tab);
        updateTabCount();
        return tab;
    }

    private void load(Tab tab, String url) {
        tab.pendingUrl = null;
        tab.view.loadUrl(url);
    }

    private void selectTab(Tab tab) {
        if (current != null && current != tab) closeFind();
        current = tab;
        webContainer.removeAllViews();
        webContainer.addView(tab.view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (tab.pendingUrl != null) load(tab, tab.pendingUrl);
        updateUi();
    }

    private void closeTab(Tab tab) {
        int index = tabs.indexOf(tab);
        if (index < 0) return;
        tabs.remove(index);
        tab.closed = true;
        webContainer.removeView(tab.view);
        tab.view.stopLoading();
        tab.view.destroy();
        if (tabs.isEmpty()) {
            current = null;
            newTab(START_URL, true);
        } else if (tab == current) {
            current = null;
            selectTab(tabs.get(Math.min(index, tabs.size() - 1)));
        }
        updateTabCount();
        if (tabsOverlay.getVisibility() == View.VISIBLE) renderTabs();
    }

    private void updateTabCount() {
        tabCount.setText(tabs.size() > 99 ? "99+" : String.valueOf(tabs.size()));
    }

    private Tab tabOf(WebView view) {
        for (Tab t : tabs) if (t.view == view) return t;
        return null;
    }

    // ───────────────────────────── Список вкладок ─────────────────────────────

    private void showTabs() {
        hideKeyboard();
        address.clearFocus();
        renderTabs();
        tabsOverlay.setVisibility(View.VISIBLE);
    }

    private void hideTabs() {
        tabsOverlay.setVisibility(View.GONE);
    }

    private void renderTabs() {
        tabsTitle.setText("Вкладки: " + tabs.size());
        tabsList.removeAllViews();
        for (Tab t : tabs) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(14), dp(10), dp(4), dp(10));
            GradientDrawable bg = new GradientDrawable();
            bg.setCornerRadius(dp(14));
            bg.setColor(getColor(t == current ? R.color.tab_active : R.color.tab_card));
            if (t == current) bg.setStroke(dp(2), getColor(R.color.accent));
            row.setBackground(bg);
            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rowLp.bottomMargin = dp(10);

            ImageView icon = new ImageView(this);
            if (t.favicon != null) icon.setImageBitmap(t.favicon);
            else icon.setImageResource(R.drawable.ic_globe);
            row.addView(icon, new LinearLayout.LayoutParams(dp(22), dp(22)));

            LinearLayout texts = new LinearLayout(this);
            texts.setOrientation(LinearLayout.VERTICAL);
            texts.setPadding(dp(12), 0, dp(8), 0);
            TextView title = new TextView(this);
            title.setText(t.title);
            title.setSingleLine(true);
            title.setEllipsize(TextUtils.TruncateAt.END);
            title.setTextColor(getColor(R.color.text));
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            title.setTypeface(Typeface.DEFAULT, t == current ? Typeface.BOLD : Typeface.NORMAL);
            TextView sub = new TextView(this);
            String u = t.pendingUrl != null ? t.pendingUrl : t.view.getUrl();
            sub.setText(isStart(u) || u == null ? "Начальная страница" : Uri.parse(u).getHost());
            sub.setSingleLine(true);
            sub.setEllipsize(TextUtils.TruncateAt.END);
            sub.setTextColor(getColor(R.color.muted));
            sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            texts.addView(title);
            texts.addView(sub);
            row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

            ImageButton close = new ImageButton(this);
            close.setImageResource(R.drawable.ic_close);
            close.setBackgroundResource(R.drawable.round_ripple);
            close.setContentDescription("Закрыть вкладку");
            close.setOnClickListener(v -> closeTab(t));
            row.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));

            row.setOnClickListener(v -> { selectTab(t); hideTabs(); });
            tabsList.addView(row, rowLp);
        }
    }

    // ───────────────────────────── WebView ─────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView(Tab tab) {
        WebView wv = new WebView(this);
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false); // начальная страница из assets всё равно доступна
        if (defaultUserAgent == null) defaultUserAgent = s.getUserAgentString();
        s.setUserAgentString(userAgent(store.desktopMode()));
        applyDarkening(wv);
        if (isDark()) wv.setBackgroundColor(getColor(R.color.bar));
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);

        wv.setWebViewClient(new PageClient(tab));
        wv.setWebChromeClient(new ChromeClient(tab));
        wv.setDownloadListener((url, ua, disposition, mime, length) -> download(url, ua, disposition, mime));
        wv.setFindListener((active, count, done) -> {
            if (tab == current && done) findCount.setText(count == 0 ? "0" : (active + 1) + " из " + count);
        });
        return wv;
    }

    /**
     * Обычный User-Agent WebView содержит «; wv» — некоторые сайты (например, вход Google)
     * из-за этого отказываются работать. Делаем его таким же, как у мобильного Chrome.
     */
    private String userAgent(boolean desktop) {
        String ua = defaultUserAgent == null ? "" : defaultUserAgent
                .replace("; wv)", ")")
                .replaceAll("Version/\\d+(\\.\\d+)* ", "");
        if (!desktop) return ua;
        Matcher m = Pattern.compile("Chrome/[\\d.]+").matcher(ua);
        String chrome = m.find() ? m.group() : "Chrome/130.0.0.0";
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                + chrome + " Safari/537.36";
    }

    private class PageClient extends WebViewClient {
        private final Tab tab;

        PageClient(Tab tab) {
            this.tab = tab;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String scheme = request.getUrl().getScheme();
            if (scheme == null) return false;
            switch (scheme.toLowerCase()) {
                case "http": case "https": case "file": case "about": case "data": case "javascript":
                    return false;
                default:
                    openExternal(view, request.getUrl().toString());
                    return true;
            }
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            tab.favicon = favicon;
            tab.progress = 0;
            if (tab == current) updateUi();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            tab.progress = 100;
            String title = view.getTitle();
            if (title != null && !title.isEmpty() && !title.startsWith("file:")) tab.title = title;
            if (isStart(url)) {
                tab.title = "Новая вкладка";
                injectStartData(tab);
            }
            if (tab == current) updateUi();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (!isReload && url != null && (url.startsWith("http://") || url.startsWith("https://")))
                store.addHistory(url, view.getTitle());
            if (tab == current) updateUi();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            String url = request.getUrl().toString();
            view.loadDataWithBaseURL(url, errorPage(url, error.getErrorCode(),
                    String.valueOf(error.getDescription())), "text/html", "utf-8", url);
        }
    }

    private class ChromeClient extends WebChromeClient {
        private final Tab tab;

        ChromeClient(Tab tab) {
            this.tab = tab;
        }

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            tab.progress = newProgress;
            if (tab == current) updateProgress();
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            if (title == null || title.isEmpty() || title.startsWith("file:")) return;
            tab.title = isStart(view.getUrl()) ? "Новая вкладка" : title;
            String url = view.getUrl();
            if (url != null) store.updateHistoryTitle(url, title);
        }

        @Override
        public void onReceivedIcon(WebView view, Bitmap icon) {
            tab.favicon = icon;
        }

        // window.open и ссылки target=_blank — новой вкладкой
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            if (!isUserGesture) return false; // блокируем всплывающие окна без нажатия пользователя
            Tab t = newTab(null, true);
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(t.view);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onCloseWindow(WebView window) {
            Tab t = tabOf(window);
            if (t != null) closeTab(t);
        }

        // <input type="file"> — выбор фото и файлов
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                toast("Не найдено приложение для выбора файлов");
                return false;
            }
            return true;
        }

        // Полноэкранное видео
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customViewCallback = callback;
            ((FrameLayout) getWindow().getDecorView()).addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            setSystemBarsHidden(true);
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    private void exitFullscreen() {
        if (customView == null) return;
        ((FrameLayout) getWindow().getDecorView()).removeView(customView);
        customView = null;
        setSystemBarsHidden(false);
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
    }

    @SuppressWarnings("deprecation")
    private void setSystemBarsHidden(boolean hidden) {
        if (Build.VERSION.SDK_INT < 30) {
            getWindow().getDecorView().setSystemUiVisibility(hidden
                    ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    : View.SYSTEM_UI_FLAG_VISIBLE);
            return;
        }
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        if (hidden) {
            c.hide(WindowInsets.Type.systemBars());
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } else {
            c.show(WindowInsets.Type.systemBars());
        }
    }

    /** Ссылки вида tel:, mailto:, intent:// (Kaspi, WhatsApp и т. п.) открываем в своих приложениях. */
    private void openExternal(WebView view, String url) {
        try {
            Intent intent;
            if (url.startsWith("intent:")) {
                intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
                try {
                    startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    String fallback = intent.getStringExtra("browser_fallback_url");
                    if (fallback != null && (fallback.startsWith("http://") || fallback.startsWith("https://"))) {
                        view.loadUrl(fallback);
                    } else if (intent.getPackage() != null) {
                        startActivity(new Intent(Intent.ACTION_VIEW,
                                Uri.parse("market://details?id=" + intent.getPackage())));
                    } else {
                        toast("Нет приложения, чтобы открыть эту ссылку");
                    }
                }
                return;
            }
            intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (URISyntaxException | ActivityNotFoundException e) {
            toast("Нет приложения, чтобы открыть эту ссылку");
        }
    }

    private void download(String url, String ua, String disposition, String mime) {
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            toast("Этот файл нельзя скачать");
            return;
        }
        String name = URLUtil.guessFileName(url, disposition, mime);
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            if (mime != null) req.setMimeType(mime);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) req.addRequestHeader("Cookie", cookies);
            req.addRequestHeader("User-Agent", ua);
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
            toast("Скачивается: " + name);
        } catch (Exception e) {
            toast("Не удалось начать загрузку");
        }
    }

    /** Передаём начальной странице частые сайты и курсы валют. */
    private void injectStartData(Tab tab) {
        String sites = store.topSites().toString();
        tab.view.evaluateJavascript(
                "window.__mb=Object.assign(window.__mb||{},{topSites:" + sites + "});", null);
        Rates.fetch(json -> runOnUiThread(() -> {
            if (tab.closed || !isStart(tab.view.getUrl())) return;
            tab.view.evaluateJavascript(
                    "window.__mb=Object.assign(window.__mb||{},{rates:" + (json == null ? "null" : json) + "});", null);
        }));
    }

    private String errorPage(String url, int code, String description) {
        String hint;
        switch (code) {
            case WebViewClient.ERROR_HOST_LOOKUP: hint = "Сайт с таким адресом не найден или нет подключения к интернету."; break;
            case WebViewClient.ERROR_CONNECT: hint = "Не удалось подключиться к сайту."; break;
            case WebViewClient.ERROR_TIMEOUT: hint = "Сайт слишком долго не отвечает."; break;
            case WebViewClient.ERROR_FAILED_SSL_HANDSHAKE: hint = "Проблема с безопасным подключением к сайту."; break;
            default: hint = "Сайт не открылся. Попробуйте ещё раз чуть позже.";
        }
        String u = TextUtils.htmlEncode(url);
        return "<!doctype html><html lang=ru><head><meta charset=utf-8>"
                + "<meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<title>Не удаётся открыть сайт</title><style>"
                + "body{font-family:sans-serif;color:#3c4043;margin:0;padding:15vh 24px 0}"
                + "h1{font-weight:500;font-size:24px;color:#202124;margin:0 0 12px}"
                + ".url{color:#5f6368;word-break:break-all}.code{color:#80868b;font-size:13px;margin-top:20px}"
                + "a{display:inline-block;margin-top:20px;background:#1a73e8;color:#fff;text-decoration:none;"
                + "padding:11px 24px;border-radius:8px;font-weight:500}"
                + "@media (prefers-color-scheme:dark){body{background:#202124;color:#bdc1c6}h1{color:#e8eaed}"
                + "a{background:#8ab4f8;color:#202124}}</style></head><body>"
                + "<h1>Не удаётся открыть сайт</h1><p class=url>" + u + "</p><p>" + hint + "</p>"
                + "<a href=\"" + u + "\">Повторить</a>"
                + "<p class=code>" + TextUtils.htmlEncode(description) + " (" + code + ")</p></body></html>";
    }

    // ───────────────────────────── Навигация и интерфейс ─────────────────────────────

    static boolean isStart(String url) {
        return url != null && url.startsWith(START_URL);
    }

    static String toUrl(String input) {
        String t = input.trim();
        if (t.isEmpty()) return null;
        if (t.matches("(?i)^(https?|file|about|data):.*")) return t;
        boolean hostLike = !t.contains(" ") && (
                t.matches("(?iu)^[^\\s/?#]+\\.\\p{L}[\\p{L}0-9-]+(:\\d+)?([/?#].*)?$")
                        || t.matches("(?i)^localhost(:\\d+)?([/?#].*)?$")
                        || t.matches("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?([/?#].*)?$"));
        if (hostLike) return (t.matches("(?i)^(localhost|\\d).*") ? "http://" : "https://") + t;
        return SEARCH + Uri.encode(t);
    }

    private void navigate(String text) {
        String url = toUrl(text);
        if (url == null || current == null) return;
        load(current, url);
        address.clearFocus();
        hideKeyboard();
        current.view.requestFocus();
    }

    private String displayUrl(Tab t) {
        String u = t.pendingUrl != null ? t.pendingUrl : t.view.getUrl();
        if (u == null || isStart(u) || "about:blank".equals(u)) return "";
        return u;
    }

    private void updateUi() {
        if (current == null) return;
        if (!address.hasFocus()) address.setText(displayUrl(current));
        boolean back = current.view.canGoBack();
        boolean forward = current.view.canGoForward();
        backBtn.setEnabled(back);
        backBtn.setAlpha(back ? 1f : 0.35f);
        forwardBtn.setEnabled(forward);
        forwardBtn.setAlpha(forward ? 1f : 0.35f);
        updateProgress();
        updateTabCount();
    }

    private void updateProgress() {
        if (current == null) return;
        boolean loading = current.progress < 100;
        progress.setVisibility(loading ? View.VISIBLE : View.INVISIBLE);
        progress.setProgress(Math.max(current.progress, 5));
        reloadBtn.setImageResource(loading ? R.drawable.ic_close : R.drawable.ic_reload);
        reloadBtn.setContentDescription(loading ? "Остановить" : "Обновить");
    }

    // ───────────────────────────── Меню ─────────────────────────────

    private static final int M_NEW_TAB = 1, M_BOOKMARK = 2, M_BOOKMARKS = 3, M_HISTORY = 4, M_FIND = 5,
            M_SHARE = 6, M_DESKTOP = 7, M_DOWNLOADS = 8, M_CLEAR = 9, M_ABOUT = 10,
            M_THEME = 11, M_DARKEN = 12;

    private void showMenu(View anchor) {
        PopupMenu popup = new PopupMenu(this, anchor);
        Menu m = popup.getMenu();
        String url = current == null ? "" : displayUrl(current);
        boolean web = url.startsWith("http");
        m.add(0, M_NEW_TAB, 0, "Новая вкладка");
        m.add(0, M_BOOKMARK, 1, store.bookmarkIndex(url) >= 0 ? "Удалить из закладок" : "Добавить в закладки")
                .setEnabled(web);
        m.add(0, M_BOOKMARKS, 2, "Закладки");
        m.add(0, M_HISTORY, 3, "История");
        m.add(0, M_DOWNLOADS, 4, "Загрузки");
        m.add(0, M_FIND, 5, "Найти на странице").setEnabled(web);
        m.add(0, M_SHARE, 6, "Поделиться ссылкой").setEnabled(web);
        m.add(0, M_DESKTOP, 7, "Версия для ПК").setCheckable(true).setChecked(store.desktopMode());
        m.add(0, M_THEME, 7, "Тема оформления…");
        if (Build.VERSION.SDK_INT >= 33)
            m.add(0, M_DARKEN, 7, "Затемнять все сайты").setCheckable(true).setChecked(store.darkenSites());
        m.add(0, M_CLEAR, 8, "Очистить данные браузера");
        m.add(0, M_ABOUT, 9, "О программе");
        popup.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case M_NEW_TAB: newTab(START_URL, true); break;
                case M_BOOKMARK: toggleBookmark(); break;
                case M_BOOKMARKS: showBookmarks(); break;
                case M_HISTORY: showHistory(); break;
                case M_DOWNLOADS: openDownloads(); break;
                case M_FIND: openFind(); break;
                case M_SHARE: share(url); break;
                case M_DESKTOP: toggleDesktopMode(); break;
                case M_CLEAR: clearData(); break;
                case M_ABOUT: showAbout(); break;
                case M_THEME: chooseTheme(); break;
                case M_DARKEN: toggleDarkenSites(); break;
                default: return false;
            }
            return true;
        });
        popup.show();
    }

    private void toggleBookmark() {
        if (current == null) return;
        String url = displayUrl(current);
        if (!url.startsWith("http")) return;
        boolean added = store.toggleBookmark(url, current.title);
        toast(added ? "Добавлено в закладки" : "Удалено из закладок");
    }

    private void showBookmarks() {
        if (store.bookmarks.length() == 0) {
            new AlertDialog.Builder(this).setTitle("Закладки")
                    .setMessage("Закладок пока нет. Откройте сайт и выберите в меню «Добавить в закладки».")
                    .setPositiveButton("OK", null).show();
            return;
        }
        List<String> titles = new ArrayList<>();
        for (int i = 0; i < store.bookmarks.length(); i++) {
            JSONObject b = store.bookmarks.optJSONObject(i);
            titles.add(b == null ? "" : b.optString("title"));
        }
        ListView list = new ListView(this);
        list.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, titles));
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Закладки")
                .setView(list)
                .setNegativeButton("Закрыть", null)
                .create();
        list.setOnItemClickListener((p, v, pos, id) -> {
            dialog.dismiss();
            JSONObject b = store.bookmarks.optJSONObject(pos);
            if (b != null && current != null) load(current, b.optString("url"));
        });
        list.setOnItemLongClickListener((p, v, pos, id) -> {
            new AlertDialog.Builder(this)
                    .setMessage("Удалить закладку «" + titles.get(pos) + "»?")
                    .setPositiveButton("Удалить", (d, w) -> { store.removeBookmark(pos); dialog.dismiss(); showBookmarks(); })
                    .setNegativeButton("Отмена", null).show();
            return true;
        });
        dialog.show();
    }

    private void showHistory() {
        List<JSONObject> items = store.recentHistory(100);
        if (items.isEmpty()) {
            new AlertDialog.Builder(this).setTitle("История").setMessage("История пуста.")
                    .setPositiveButton("OK", null).show();
            return;
        }
        List<String> titles = new ArrayList<>();
        java.text.DateFormat time = android.text.format.DateFormat.getTimeFormat(this);
        java.text.DateFormat date = android.text.format.DateFormat.getDateFormat(this);
        long today = System.currentTimeMillis() - (System.currentTimeMillis() % 86400000L);
        for (JSONObject h : items) {
            long t = h.optLong("time");
            String when = t >= today ? time.format(t) : date.format(t);
            titles.add(when + "  ·  " + h.optString("title"));
        }
        ListView list = new ListView(this);
        list.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, titles));
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("История")
                .setView(list)
                .setNegativeButton("Закрыть", null)
                .setNeutralButton("Очистить", (d, w) -> new AlertDialog.Builder(this)
                        .setMessage("Удалить всю историю посещений?")
                        .setPositiveButton("Удалить", (d2, w2) -> { store.clearHistory(); toast("История очищена"); })
                        .setNegativeButton("Отмена", null).show())
                .create();
        list.setOnItemClickListener((p, v, pos, id) -> {
            dialog.dismiss();
            if (current != null) load(current, items.get(pos).optString("url"));
        });
        dialog.show();
    }

    private void openDownloads() {
        try {
            startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
        } catch (ActivityNotFoundException e) {
            toast("Откройте папку «Загрузки» в приложении «Файлы»");
        }
    }

    private void share(String url) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, url);
        if (current != null) send.putExtra(Intent.EXTRA_SUBJECT, current.title);
        startActivity(Intent.createChooser(send, "Поделиться ссылкой"));
    }

    private void toggleDesktopMode() {
        boolean on = !store.desktopMode();
        store.setDesktopMode(on);
        for (Tab t : tabs) t.view.getSettings().setUserAgentString(userAgent(on));
        if (current != null && current.pendingUrl == null) current.view.reload();
        toast(on ? "Включена версия для ПК" : "Включена мобильная версия");
    }

    private void clearData() {
        new AlertDialog.Builder(this)
                .setTitle("Очистить данные браузера?")
                .setMessage("Будут удалены история, кэш, файлы cookie и настройки начальной страницы. "
                        + "На сайтах придётся войти заново. Закладки сохранятся.")
                .setPositiveButton("Очистить", (d, w) -> {
                    CookieManager.getInstance().removeAllCookies(null);
                    WebStorage.getInstance().deleteAllData();
                    for (Tab t : tabs) { t.view.clearCache(true); t.view.clearHistory(); }
                    store.clearHistory();
                    toast("Данные очищены");
                })
                .setNegativeButton("Отмена", null).show();
    }

    private void showAbout() {
        String version = "";
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        new AlertDialog.Builder(this)
                .setTitle("Мой браузер " + version)
                .setMessage("Мобильная версия «Моего браузера».\nДвижок: Android System WebView (Chromium).")
                .setPositiveButton("OK", null).show();
    }

    // ───────────────────────────── Поиск по странице ─────────────────────────────

    private void openFind() {
        hideTabs();
        findBar.setVisibility(View.VISIBLE);
        findInput.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        imm.showSoftInput(findInput, InputMethodManager.SHOW_IMPLICIT);
    }

    private void closeFind() {
        if (findBar.getVisibility() != View.VISIBLE) return;
        findBar.setVisibility(View.GONE);
        findInput.setText("");
        findCount.setText("");
        if (current != null) current.view.clearMatches();
        hideKeyboard();
    }

    // ───────────────────────────── Кнопка «Назад» ─────────────────────────────

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (customView != null) { exitFullscreen(); return; }
        if (tabsOverlay.getVisibility() == View.VISIBLE) { hideTabs(); return; }
        if (findBar.getVisibility() == View.VISIBLE) { closeFind(); return; }
        if (address.hasFocus()) { address.clearFocus(); hideKeyboard(); return; }
        if (current != null && current.view.canGoBack()) { current.view.goBack(); return; }
        if (tabs.size() > 1 && current != null) { closeTab(current); return; }
        super.onBackPressed();
    }

    // ───────────────────────────── Мелочи ─────────────────────────────

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        View focus = getCurrentFocus();
        imm.hideSoftInputFromWindow(focus != null ? focus.getWindowToken() : address.getWindowToken(), 0);
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        for (Tab t : tabs) t.view.destroy();
        super.onDestroy();
    }
}
