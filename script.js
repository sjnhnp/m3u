document.addEventListener('DOMContentLoaded', () => {
    const m3uUrlInput = document.getElementById('m3uUrlInput');
    const loadM3uButton = document.getElementById('loadM3uButton');
    const channelListUl = document.getElementById('channelList');
    const videoPlayer = document.getElementById('videoPlayer');
    const statusMessage = document.getElementById('statusMessage');

    let hls = null; // hls.js instance
    const storageKey = 'm3uPlayerUrl'; // localStorage key

    // --- HLS Player Setup ---
    if (Hls.isSupported()) {
        hls = new Hls();
        hls.attachMedia(videoPlayer);
        hls.on(Hls.Events.ERROR, function (event, data) {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        console.error('Fatal network error encountered', data);
                        setStatus(`网络错误，无法加载流: ${data.details}`, true);
                        // Try to recover network error
                        // hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.error('Fatal media error encountered', data);
                        setStatus(`媒体错误: ${data.details}`, true);
                         // Try to recover media error
                        // hls.recoverMediaError();
                        break;
                    default:
                        console.error('Fatal error encountered', data);
                        setStatus(`播放错误: ${data.details}`, true);
                        // Cannot recover, destroy HLS instance
                        // hls.destroy();
                        break;
                }
            } else {
                 console.warn('Non-fatal HLS error:', data);
                 setStatus(`播放警告: ${data.details}`, false, true); // Show as warning
            }
        });
    } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (e.g., Safari) - hls.js not needed
        console.log("Using native HLS playback.");
    } else {
        setStatus("您的浏览器不支持 HLS 播放。", true);
    }

    // --- UI Event Listeners ---
    loadM3uButton.addEventListener('click', loadM3uFromInput);
    m3uUrlInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            loadM3uFromInput();
        }
    });

    // --- Functions ---
    function setStatus(message, isError = false, isWarning = false) {
        statusMessage.textContent = message;
        statusMessage.classList.remove('loading', 'success', 'error'); // Clear previous states
        if (isError) {
            statusMessage.classList.add('error');
        } else if (isWarning) {
             statusMessage.classList.add('warning'); // Or use a different class if defined in CSS
        } else {
            statusMessage.classList.add('success'); // Default to success/info styling
        }
        // Automatically clear status after some time? Maybe not for errors.
        // setTimeout(() => statusMessage.textContent = '', 5000);
    }

    function loadM3uFromInput() {
        const url = m3uUrlInput.value.trim();
        if (!url) {
            setStatus("请输入有效的 M3U URL。", true);
            return;
        }

        // Basic URL validation (can be improved)
        try {
            new URL(url);
        } catch (_) {
            setStatus("URL 格式无效。", true);
            return;
        }

        // Save URL to localStorage
        localStorage.setItem(storageKey, url);
        console.log(`Saved URL to localStorage: ${url}`);

        fetchAndParseM3u(url);
    }

    async function fetchAndParseM3u(m3uUrl) {
        setStatus("正在加载 M3U 列表...", false);
        channelListUl.innerHTML = ''; // Clear previous list

        try {
            // Call the Cloudflare Function proxy
            const response = await fetch(`/api/fetch-m3u?url=${encodeURIComponent(m3uUrl)}`);

            if (!response.ok) {
                throw new Error(`无法获取 M3U 文件: ${response.status} ${response.statusText}`);
            }

            const m3uText = await response.text();
            const channels = parseM3U(m3uText);

            if (channels.length === 0) {
                setStatus("M3U 文件为空或无法解析频道。", true);
                return;
            }

            displayChannels(channels);
            setStatus(`成功加载 ${channels.length} 个频道。`, false);

        } catch (error) {
            console.error("加载 M3U 时出错:", error);
            setStatus(`加载 M3U 失败: ${error.message}`, true);
            // Optionally clear localStorage if fetch fails?
            // localStorage.removeItem(storageKey);
        }
    }

    function parseM3U(m3uText) {
        const lines = m3uText.split('\n');
        const channels = [];
        let currentChannel = {};

        // Basic M3U check
        if (!lines[0].toUpperCase().startsWith('#EXTM3U')) {
            console.warn("文件可能不是有效的 M3U 格式 (缺少 #EXTM3U 标签)。");
            // Continue parsing anyway, might still work for simple lists
        }


        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.toUpperCase().startsWith('#EXTINF:')) {
                // Start of a channel entry
                currentChannel = { name: '', url: '', logo: '', group: '' }; // Reset for new channel

                // Extract duration and attributes (tvg-id, tvg-name, tvg-logo, group-title)
                const infoLine = line.substring(8); // Remove #EXTINF:
                const commaIndex = infoLine.indexOf(',');
                if (commaIndex !== -1) {
                    const attributesPart = infoLine.substring(0, commaIndex);
                    currentChannel.name = infoLine.substring(commaIndex + 1).trim(); // Name is usually after the comma

                    // Simple attribute parsing (can be made more robust)
                    const attributes = attributesPart.match(/([a-zA-Z0-9\-]+)="([^"]*)"/g) || [];
                    attributes.forEach(attr => {
                         const [_, key, value] = attr.match(/([a-zA-Z0-9\-]+)="([^"]*)"/) || [];
                        if (key && value) {
                            if (key.toLowerCase() === 'tvg-logo') currentChannel.logo = value;
                            if (key.toLowerCase() === 'group-title') currentChannel.group = value;
                            // Add more attribute extractions if needed (tvg-id, etc.)
                        }
                    });

                } else {
                     // Fallback if no comma found (less common format)
                     currentChannel.name = infoLine.trim();
                }


            } else if (line && !line.startsWith('#') && currentChannel.name) {
                // This line should be the URL for the previously found #EXTINF
                currentChannel.url = line;
                channels.push(currentChannel);
                // console.log("Parsed Channel:", currentChannel); // Debug log
                currentChannel = {}; // Reset for safety, though EXTINF should reset it
            }
        }
        console.log(`Parsed ${channels.length} channels.`);
        return channels;
    }

    function displayChannels(channels) {
        channelListUl.innerHTML = ''; // Clear again just in case
        channels.forEach((channel, index) => {
            const li = document.createElement('li');
            li.textContent = channel.name || `频道 ${index + 1}`; // Fallback name
            li.title = `URL: ${channel.url}\n分组: ${channel.group || '无'}`; // Tooltip
            li.dataset.url = channel.url; // Store URL in data attribute

            // Add logo if available (optional)
            if (channel.logo) {
                const img = document.createElement('img');
                img.src = channel.logo;
                img.style.width = '20px';
                img.style.height = 'auto';
                img.style.marginRight = '8px';
                img.style.verticalAlign = 'middle';
                img.onerror = function() { this.style.display='none'; }; // Hide if logo fails to load
                li.prepend(img); // Add logo before text
            }

            li.addEventListener('click', () => {
                playChannel(channel.url, li);
            });

            channelListUl.appendChild(li);
        });
    }

    function playChannel(url, clickedLi = null) {
        if (!url) {
            setStatus("无效的频道 URL。", true);
            return;
        }
        console.log(`尝试播放: ${url}`);
        setStatus(`正在加载: ${url}`, false); // Inform user

        // Highlight active channel
        document.querySelectorAll('#channelList li').forEach(item => item.classList.remove('active'));
        if (clickedLi) {
            clickedLi.classList.add('active');
        }


        if (hls) { // Use hls.js if initialized
            hls.loadSource(url);
             hls.once(Hls.Events.MANIFEST_PARSED, function() {
                 videoPlayer.play().catch(e => console.warn("Autoplay prevented:", e));
                 setStatus(`正在播放: ${clickedLi ? clickedLi.textContent.trim() : url}`, false);
             });
        } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) { // Native HLS
            videoPlayer.src = url;
            videoPlayer.addEventListener('loadedmetadata', () => {
                 videoPlayer.play().catch(e => console.warn("Autoplay prevented:", e));
                 setStatus(`正在播放: ${clickedLi ? clickedLi.textContent.trim() : url}`, false);
            });
             videoPlayer.addEventListener('error', (e) => {
                 console.error("Native HLS Error:", e);
                 setStatus(`无法播放此流 (native): ${url}`, true);
             });
        } else {
            setStatus("无法播放 HLS 流。", true);
        }
    }

    // --- Initial Load ---
    function initialize() {
        const savedUrl = localStorage.getItem(storageKey);
        if (savedUrl) {
            m3uUrlInput.value = savedUrl;
            console.log(`Loaded URL from localStorage: ${savedUrl}`);
            fetchAndParseM3u(savedUrl); // Automatically load on startup if URL exists
        } else {
             setStatus("请输入 M3U 订阅地址并点击加载。", false, true); // Show as info/warning
        }
    }

    initialize(); // Run initialization on page load
});
