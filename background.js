// background.js - Advanced background service worker for Pitch Shifter Pro v2
// Thêm biến để theo dõi tần suất log
let debugLogCount = 0;
const maxDebugLogs = 5; // Giới hạn số lần log để tránh spam
function resetDebugLogCount() {
  debugLogCount = 0;
  console.log("Đã reset debugLogCount để ghi log mới.");
}
// Default settings for new tabs
const defaultSettings = {
  pitch: 0,
  playbackRate: 1,
  boost: 0.8,
  pan: 0,
  transpose: true,
  soundProfile: "proNatural",
  bassGain: 0,
  midGain: 0,
  trebleGain: 0,
  enabled: false,
  held: false,
  bpm: null,
  key: null
};
// Supported URL patterns (from manifest.json)
const supportedPatterns = ["*://*.youtube.com/*", "*://*.vimeo.com/*", "*://*.soundcloud.com/*", "*://*.dailymotion.com/*", "*://*.twitch.tv/*"];
// Helper: Check if URL is supported
function isSupportedUrl(url) {
  if (!url) return false;
  return supportedPatterns.some(pattern => {
    const regex = new RegExp(pattern.replace(/\*/g, ".*"));
    return regex.test(url);
  });
}
// Helper: Log errors with context
function logError(message, error, context = {}) {
  const errorMessage = error?.message || (error ? JSON.stringify(error, null, 2) : "Unknown error");
  const contextDetails = {
    ...context,
    senderTabId: context.sender?.tab?.id,
    senderUrl: context.sender?.tab?.url,
    senderOrigin: context.sender?.origin,
    messageDetails: context.message ? JSON.stringify(context.message, null, 2) : "No message provided",
    timestamp: new Date().toISOString()
  };
  console.error(`${message}: ${errorMessage}`, {
    error,
    context: contextDetails,
    stack: error?.stack || new Error().stack
  });
}
// Helper: Update extension icon
function updateIcon(tabId, enabled) {
  if (!tabId) return;

  chrome.tabs.get(tabId, (tab) => {
    // Tab đã đóng hoặc không tồn tại → bỏ qua im lặng
    if (chrome.runtime.lastError || !tab) {
      return;
    }

    const iconPath = enabled ? {
      "16": "icon16.png",
      "48": "icon48.png",
      "128": "icon128.png"
    } : {
      "16": "icon16.png",
      "48": "icon48_disabled.png",
      "128": "icon128.png"
    };

    chrome.action.setIcon({
      path: iconPath,
      tabId
    }, () => {
      // Chỉ log khi lỗi thật sự khác (không phải "No tab with id")
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "";
        if (!/No tab with id/i.test(msg)) {
          logError("Failed to set icon", chrome.runtime.lastError, { tabId });
        }
      }
    });
  });
}
// Helper: Debounce function
function debounce(func, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}
// Helper: Send message to tab with retry logic
function sendMessageToTab(tabId, message, callback, retries = 3) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      logError("Tab not found or invalid", chrome.runtime.lastError || new Error("Tab does not exist"), {
        tabId,
        message
      });
      updateIcon(tabId, false);
      if (callback) callback({
        status: "error",
        message: "Tab not found"
      });
      return;
    }
    if (!isSupportedUrl(tab.url)) {
      logError("Tab URL not supported", new Error("Unsupported URL"), {
        tabId,
        url: tab.url,
        message
      });
      updateIcon(tabId, false);
      if (callback) callback({
        status: "error",
        message: "Tab URL not supported"
      });
      return;
    }
    if (tab.status !== "complete") {
      if (retries > 0) {
        console.warn(`Tab ${tabId} not loaded, retrying (${retries} attempts left)`);
        setTimeout(() => sendMessageToTab(tabId, message, callback, retries - 1), 1000); // Tăng thời gian chờ lên 1000ms
      } else {
        logError("Tab not fully loaded after retries", new Error("Tab loading timeout"), {
          tabId,
          url: tab.url,
          message
        });
        updateIcon(tabId, false);
        if (callback) callback({
          status: "error",
          message: "Tab not fully loaded"
        });
      }
      return;
    }
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError && retries > 0) {
        console.warn(`Retrying message to tab ${tabId} (${retries} attempts left): ${chrome.runtime.lastError.message}`);
        setTimeout(() => sendMessageToTab(tabId, message, callback, retries - 1), 500);
      } else if (chrome.runtime.lastError) {
        logError("Failed to send message to tab", chrome.runtime.lastError, {
          tabId,
          message
        });
        if (callback) callback({
          status: "error",
          message: `Could not connect to tab: ${chrome.runtime.lastError.message}`
        });
      } else {
        if (callback) callback(response || {
          status: "error",
          message: "No response from tab"
        });
      }
    });
  });
}
// Debounced version of sendMessageToTab
const sendMessageToTabDebounced = debounce(sendMessageToTab, 200);
// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab) {
    try {
      if (message.action === "refreshExtension") {
        chrome.tabs.query({
          active: true,
          currentWindow: true
        }, (tabs) => {
          if (!tabs[0]) {
            logError("No active tab found for refreshExtension", null, {
              sender,
              message
            });
            sendResponse({
              status: "error",
              message: "No active tab found"
            });
            return;
          }
          const tabId = tabs[0].id;
          if (!isSupportedUrl(tabs[0].url)) {
            logError("Active tab URL not supported", null, {
              tabId,
              url: tabs[0].url,
              message
            });
            sendResponse({
              status: "error",
              message: "Active tab URL not supported"
            });
            return;
          }
          chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
            if (chrome.runtime.lastError) {
              logError("Failed to get storage for refreshExtension", chrome.runtime.lastError, {
                tabId,
                message
              });
              sendResponse({
                status: "error",
                message: "Storage error"
              });
              return;
            }
            const {
              activeTab,
              tabStates = {}
            } = result;
            const state = tabStates[tabId] || {
              ...defaultSettings
            };
            sendMessageToTabDebounced(tabId, {
              type: "restore",
              ...state
            }, (response) => {
              if (response?.status === "success") {
                updateIcon(tabId, state.enabled);
                console.log(`Tab ${tabId} refreshed with state:`, state);
                sendResponse({
                  status: "success",
                  message: "Extension refreshed"
                });
              } else {
                logError("Failed to refresh extension", null, {
                  tabId,
                  response,
                  message
                });
                sendResponse(response || {
                  status: "error",
                  message: "Failed to refresh extension"
                });
              }
            });
          });
        });
      } else {
        logError("Unknown message from non-tab sender", null, {
          sender,
          messageType: message.type || message.action
        });
        sendResponse({
          status: "error",
          message: `Unknown action: ${message.action || message.type || "undefined"}`
        });
      }
    } catch (error) {
      logError("Error handling non-tab sender message", error, {
        sender,
        message
      });
      sendResponse({
        status: "error",
        message: error.message || "Unknown error in non-tab sender"
      });
    }
    return true; // Giữ kênh mở cho phản hồi bất đồng bộ
  }
  if (!sender.tab.id || !sender.tab.url || !isSupportedUrl(sender.tab.url)) {
    logError("Invalid or unsupported tab sender", null, {
      sender,
      tabId: sender.tab.id,
      url: sender.tab.url,
      messageType: message.type
    });
    sendResponse({
      status: "error",
      message: "No valid tab sender or unsupported URL"
    });
    return true;
  }
  const tabId = sender.tab.id;
  switch (message.type) {
    case "ping":
      sendResponse({
        status: "pong"
      });
      return false; // Đồng bộ, không async
    case "checkFirstRunAfterUpdate":
      chrome.storage.local.get(["lastVersion"], (result) => {
        const manifest = chrome.runtime.getManifest();
        const currentVersion = manifest.version;
        const lastVersion = result.lastVersion || "0.0.0";
        if (lastVersion !== currentVersion) {
          chrome.storage.local.set({
            lastVersion: currentVersion
          });
          sendResponse({
            isFirstRun: true
          });
        } else {
          sendResponse({
            isFirstRun: false
          });
        }
      });
      return true; // Async response
    case "toggle_enabled":
      chrome.storage.local.get(["activeTab", "tabStates", "isEnabled"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Failed to get storage for toggle_enabled", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Storage error"
          });
          return;
        }
        let {
          activeTab,
          tabStates = {},
          isEnabled = false
        } = result;
        if (message.enabled) {
          tabStates[tabId] = {
            ...defaultSettings,
            enabled: true,
            ...tabStates[tabId]
          };
          isEnabled = true;
          chrome.storage.local.set({
            activeTab: tabId,
            tabStates,
            isEnabled
          }, () => {
            if (chrome.runtime.lastError) {
              logError("Failed to set storage for enable", chrome.runtime.lastError, {
                tabId
              });
              sendResponse({
                status: "error",
                message: "Storage error"
              });
              return;
            }
            sendMessageToTabDebounced(tabId, {
              enabled: true
            }, (response) => {
              if (response?.status === "success") {
                updateIcon(tabId, true);
                sendResponse({
                  status: "success",
                  message: "Pitch Shifter enabled"
                });
              } else {
                logError("Failed to enable Pitch Shifter", null, {
                  tabId,
                  response
                });
                sendResponse(response || {
                  status: "error",
                  message: "Failed to enable"
                });
              }
            });
          });
        } else if (activeTab === tabId) {
          delete tabStates[tabId];
          isEnabled = false;
          chrome.storage.local.set({
            activeTab: null,
            tabStates,
            isEnabled
          }, () => {
            if (chrome.runtime.lastError) {
              logError("Failed to set storage for disable", chrome.runtime.lastError, {
                tabId
              });
              sendResponse({
                status: "error",
                message: "Storage error"
              });
              return;
            }
            sendMessageToTabDebounced(tabId, {
              enabled: false
            }, (response) => {
              if (response?.status === "success") {
                updateIcon(tabId, false);
                sendResponse({
                  status: "success",
                  message: "Pitch Shifter disabled"
                });
              } else {
                logError("Failed to disable Pitch Shifter", null, {
                  tabId,
                  response
                });
                sendResponse(response || {
                  status: "error",
                  message: "Failed to disable"
                });
              }
            });
          });
        } else {
          sendResponse({
            status: "success",
            message: "No action needed"
          });
        }
      });
      break;
    case "restore_state":
      chrome.storage.local.get(["tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Failed to get storage for restore_state", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Storage error"
          });
          return;
        }
        const tabStates = result.tabStates || {};
        const state = tabStates[tabId] || {
          ...defaultSettings
        };
        sendMessageToTabDebounced(tabId, {
          type: "restore",
          ...state
        }, (response) => {
          if (response?.status === "success") {
            sendResponse(response);
          } else {
            logError("Failed to restore state", null, {
              tabId,
              response
            });
            sendResponse(response || {
              status: "error",
              message: "Failed to restore state"
            });
          }
        });
      });
      break;
    case "get_tab_status":
      chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Failed to get storage for get_tab_status", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Storage error"
          });
          return;
        }
        const {
          activeTab,
          tabStates = {}
        } = result;
        const state = tabStates[tabId] || {
          ...defaultSettings
        };
        sendMessageToTabDebounced(tabId, {
          type: "get"
        }, (response) => {
          if (response?.status === "success") {
            updateIcon(tabId, activeTab === tabId && state.enabled);
            sendResponse({
              status: "success",
              data: {
                ...response,
                ...state,
                enabled: activeTab === tabId && state.enabled
              }
            });
          } else {
            logError("Failed to get tab status", null, {
              tabId,
              response
            });
            sendResponse(response || {
              status: "error",
              message: "Failed to get status"
            });
          }
        });
      });
      break;
    case "bpmUpdate":
      chrome.storage.local.get(["tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Lỗi khi lấy storage cho bpmUpdate", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Lỗi storage"
          });
          return;
        }
        let tabStates = result.tabStates || {};
        if (tabStates[tabId]?.enabled) {
          const confidencePercent = message.confidence ? Math.round(message.confidence * 100) : "N/A";
          console.log(`Tab ${tabId}: BPM cập nhật thành ${message.bpm} (Độ tin cậy: ${confidencePercent}%)`);
          tabStates[tabId].bpm = message.bpm;
          tabStates[tabId].key = message.key;
          chrome.storage.local.set({
            tabStates
          }, () => {
            if (chrome.runtime.lastError) {
              logError("Lỗi khi lưu cập nhật BPM", chrome.runtime.lastError, {
                tabId
              });
            }
            sendResponse({
              status: "success",
              message: "Cập nhật BPM thành công",
              bpm: message.bpm,
              confidence: message.confidence
            });
            if (debugLogCount < maxDebugLogs) {
              chrome.runtime.sendMessage({
                type: "bpmUpdate",
                bpm: message.bpm,
                key: message.key,
                confidence: message.confidence
              }, () => {
                if (chrome.runtime.lastError && debugLogCount < maxDebugLogs) {
                  console.debug(`Popup chưa mở, cập nhật BPM không được chuyển tiếp (log ${debugLogCount + 1}/${maxDebugLogs})`);
                  debugLogCount++;
                }
              });
            }
          });
        } else {
          sendResponse({
            status: "error",
            message: "Tab chưa được kích hoạt"
          });
        }
      });
      break;
    case "bpmStatus":
      if (debugLogCount < maxDebugLogs) {
        chrome.runtime.sendMessage({
          type: "bpmStatus",
          message: message.message
        }, () => {
          if (chrome.runtime.lastError && debugLogCount < maxDebugLogs) {
            console.debug(`Popup chưa mở, trạng thái BPM không được chuyển tiếp (log ${debugLogCount + 1}/${maxDebugLogs})`);
            debugLogCount++;
          }
        });
      }
      sendResponse({
        status: "success",
        message: "Đã nhận trạng thái BPM"
      });
      break;
    case "get_tab_status":
      chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Lỗi khi lấy storage cho get_tab_status", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Lỗi storage"
          });
          return;
        }
        const {
          activeTab,
          tabStates = {}
        } = result;
        const state = tabStates[tabId] || {
          ...defaultSettings
        };
        sendMessageToTabDebounced(tabId, {
          type: "get"
        }, (response) => {
          if (response?.status === "success") {
            updateIcon(tabId, activeTab === tabId && state.enabled);
            sendResponse({
              status: "success",
              data: {
                ...response,
                ...state,
                enabled: activeTab === tabId && state.enabled,
                bpm: state.bpm || response.bpm || null, // Đồng bộ BPM
                key: state.key || response.key || null // Đồng bộ key
              }
            });
          } else {
            logError("Lỗi khi lấy trạng thái tab", null, {
              tabId,
              response
            });
            sendResponse({
              status: "error",
              message: "Lỗi khi lấy trạng thái",
              bpm: state.bpm || null,
              key: state.key || null
            });
          }
        });
      });
      break;
    case "apply_settings":
      chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Failed to get storage for apply_settings", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Storage error"
          });
          return;
        }
        const {
          activeTab,
          tabStates = {}
        } = result;
        if (activeTab !== tabId) {
          sendResponse({
            status: "error",
            message: "Tab not active"
          });
          return;
        }
        const newState = {
          pitch: message.pitch ?? tabStates[tabId]?.pitch ?? 0,
          playbackRate: message.playbackRate ?? tabStates[tabId]?.playbackRate ?? 1,
          boost: message.boost ?? tabStates[tabId]?.boost ?? 0.8,
          pan: message.pan ?? tabStates[tabId]?.pan ?? 0,
          transpose: message.transpose ?? tabStates[tabId]?.transpose ?? true,
          soundProfile: message.soundProfile ?? tabStates[tabId]?.soundProfile ?? "proNatural",
          bassGain: message.bassGain ?? tabStates[tabId]?.bassGain ?? 0,
          midGain: message.midGain ?? tabStates[tabId]?.midGain ?? 0,
          trebleGain: message.trebleGain ?? tabStates[tabId]?.trebleGain ?? 0,
          enabled: true,
          held: tabStates[tabId]?.held ?? false
        };
        tabStates[tabId] = newState;
        chrome.storage.local.set({
          tabStates
        }, () => {
          if (chrome.runtime.lastError) {
            logError("Failed to save settings", chrome.runtime.lastError, {
              tabId
            });
            sendResponse({
              status: "error",
              message: "Storage error"
            });
            return;
          }
          sendMessageToTabDebounced(tabId, {
            type: "apply_settings",
            ...newState
          }, (response) => {
            if (response?.status === "success") {
              console.log(`Settings applied on tab ${tabId}:`, newState);
              sendResponse({
                status: "success",
                message: "Settings applied",
                soundProfile: response.soundProfile
              });
            } else {
              logError("Failed to apply settings", null, {
                tabId,
                response
              });
              sendResponse(response || {
                status: "error",
                message: "Failed to apply settings"
              });
            }
          });
        });
      });
      break;
    case "videoChanged":
      chrome.storage.local.get(["tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Failed to get storage for videoChanged", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Storage error"
          });
          return;
        }
        let tabStates = result.tabStates || {};
        if (tabStates[tabId]?.enabled && !message.holdState) {
          tabStates[tabId].soundProfile = message.soundProfile ?? tabStates[tabId].soundProfile;
          tabStates[tabId].pitch = message.pitch ?? tabStates[tabId].pitch;
          tabStates[tabId].playbackRate = message.playbackRate ?? tabStates[tabId].playbackRate;
          tabStates[tabId].boost = message.boost ?? tabStates[tabId].boost;
          tabStates[tabId].pan = message.pan ?? tabStates[tabId].pan;
          tabStates[tabId].transpose = message.transpose ?? tabStates[tabId].transpose;
          chrome.storage.local.set({
            tabStates
          }, () => {
            if (chrome.runtime.lastError) {
              logError("Failed to save settings from videoChanged", chrome.runtime.lastError, {
                tabId
              });
            }
            console.log(`Updated settings for ${message.videoSrc} on tab ${tabId}:`, tabStates[tabId]);
          });
          chrome.runtime.sendMessage({
            type: "videoChanged",
            videoSrc: message.videoSrc,
            title: message.title
          }, () => {
            if (chrome.runtime.lastError) {
              console.debug("Popup not open, videoChanged not forwarded");
            }
          });
        }
        sendResponse({
          status: "success",
          message: "Video change processed"
        });
      });
      break;
    case "hold":
      chrome.storage.local.get(["tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Failed to get storage for hold", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Storage error"
          });
          return;
        }
        let tabStates = result.tabStates || {};
        if (tabStates[tabId]) {
          tabStates[tabId].held = message.holdState;
          chrome.storage.local.set({
            tabStates
          }, () => {
            if (chrome.runtime.lastError) {
              logError("Failed to save hold state", chrome.runtime.lastError, {
                tabId
              });
            }
            sendMessageToTabDebounced(tabId, {
              type: "hold",
              holdState: message.holdState
            }, (response) => {
              if (response?.status === "success") {
                console.log(`Tab ${tabId} hold state set to ${message.holdState}`);
                sendResponse({
                  status: "success",
                  message: "Hold state updated"
                });
              } else {
                logError("Failed to update hold state", null, {
                  tabId,
                  response
                });
                sendResponse(response || {
                  status: "error",
                  message: "Failed to update hold state"
                });
              }
            });
          });
        } else {
          sendResponse({
            status: "error",
            message: "Tab state not found"
          });
        }
      });
      break;
    case "save_favorite":
      chrome.storage.local.get(["tabStates", "favorites"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Failed to get storage for save_favorite", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Storage error"
          });
          return;
        }
        let tabStates = result.tabStates || {};
        let favorites = Array.isArray(result.favorites) ? result.favorites : [];
        if (tabStates[tabId]) {
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              logError("Failed to get tab for favorite", chrome.runtime.lastError, {
                tabId
              });
              sendResponse({
                status: "error",
                message: "Tab not found"
              });
              return;
            }
            const url = tab.url.split(/[?#]/)[0];
            const favorite = {
              link: url,
              pitch: tabStates[tabId].pitch,
              playbackRate: tabStates[tabId].playbackRate,
              boost: tabStates[tabId].boost,
              pan: tabStates[tabId].pan,
              transpose: tabStates[tabId].transpose,
              soundProfile: tabStates[tabId].soundProfile,
              bpm: message.bpm || tabStates[tabId].bpm,
              key: message.key || tabStates[tabId].key,
              title: tab.title || "Unknown",
              timestamp: Date.now()
            };
            const existingIndex = favorites.findIndex(f => f.link === url);
            if (existingIndex >= 0) favorites[existingIndex] = favorite;
            else favorites.push(favorite);
            chrome.storage.local.set({
              favorites
            }, () => {
              if (chrome.runtime.lastError) {
                logError("Failed to save favorite", chrome.runtime.lastError, {
                  tabId
                });
              }
              console.log(`Favorite saved for ${url}:`, favorite);
              sendResponse({
                status: "success",
                message: "Favorite saved"
              });
            });
          });
        } else {
          sendResponse({
            status: "error",
            message: "Tab state not found"
          });
        }
      });
      break;
    case "error":
      logError(`Error from tab ${tabId}`, null, {
        message: message.message,
        details: message.details
      });
      sendResponse({
        status: "error_logged"
      });
      break;
    case "refreshExtension":
      chrome.tabs.query({
        active: true,
        currentWindow: true
      }, (tabs) => {
        if (!tabs || tabs.length === 0 || !tabs[0]) {
          logError("No active tab found for refreshExtension", new Error("No active tab"), {
            sender,
            message
          });
          sendResponse({
            status: "error",
            message: "No active tab found"
          });
          return;
        }
        const tab = tabs[0];
        const tabId = tab.id;
        const tabUrl = tab.url;
        if (!isSupportedUrl(tabUrl)) {
          logError("Active tab URL not supported", new Error("Unsupported URL"), {
            tabId,
            url: tabUrl,
            message
          });
          sendResponse({
            status: "error",
            message: "Active tab URL not supported"
          });
          return;
        }
        if (tab.status !== "complete") {
          logError("Active tab not fully loaded", new Error("Tab loading"), {
            tabId,
            url: tabUrl,
            message
          });
          sendResponse({
            status: "error",
            message: "Tab not fully loaded"
          });
          return;
        }
        chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
          if (chrome.runtime.lastError) {
            logError("Failed to get storage for refreshExtension", chrome.runtime.lastError, {
              tabId,
              message
            });
            sendResponse({
              status: "error",
              message: "Storage error"
            });
            return;
          }
          const {
            activeTab,
            tabStates = {}
          } = result;
          if (activeTab !== tabId) {
            logError("Tab not active for refreshExtension", new Error("Tab not active"), {
              tabId,
              activeTab,
              message
            });
            sendResponse({
              status: "error",
              message: "Tab not active"
            });
            return;
          }
          const state = tabStates[tabId] || {
            ...defaultSettings
          };
          chrome.scripting.executeScript({
            target: {
              tabId
            },
            files: ["jungle.js", "content.js"]
          }, () => {
            if (chrome.runtime.lastError) {
              logError("Failed to inject content script for refreshExtension", chrome.runtime.lastError, {
                tabId,
                message
              });
              sendResponse({
                status: "error",
                message: "Failed to inject content script"
              });
              return;
            }
            sendMessageToTabDebounced(tabId, {
              type: "restore",
              ...state
            }, (response) => {
              if (response?.status === "success" || response?.status === "state refreshed") {
                updateIcon(tabId, state.enabled);
                console.log(`Tab ${tabId} refreshed with state:`, state);
                sendResponse({
                  status: "success",
                  message: "Extension refreshed"
                });
              } else {
                logError("Failed to refresh extension", response?.error || new Error(`Unknown error: ${JSON.stringify(response)}`), {
                  tabId,
                  response,
                  message
                });
                sendResponse(response || {
                  status: "error",
                  message: "Failed to refresh extension"
                });
              }
            });
          });
        });
      });
      break;
    case "settingsUpdated":
      chrome.storage.local.get(["tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Failed to get storage for settingsUpdated", chrome.runtime.lastError, {
            tabId
          });
          sendResponse({
            status: "error",
            message: "Storage error"
          });
          return;
        }
        let tabStates = result.tabStates || {};
        if (tabStates[tabId]?.enabled && !tabStates[tabId].held) {
          tabStates[tabId] = {
            ...tabStates[tabId],
            pitch: message.pitch ?? tabStates[tabId].pitch,
            playbackRate: message.playbackRate ?? tabStates[tabId].playbackRate,
            boost: message.boost ?? tabStates[tabId].boost,
            pan: message.pan ?? tabStates[tabId].pan,
            transpose: message.transpose ?? tabStates[tabId].transpose,
            soundProfile: message.soundProfile ?? tabStates[tabId].soundProfile
          };
          chrome.storage.local.set({
            tabStates
          }, () => {
            if (chrome.runtime.lastError) {
              logError("Failed to save settings from settingsUpdated", chrome.runtime.lastError, {
                tabId
              });
            }
            console.log(`Settings updated for tab ${tabId}:`, tabStates[tabId]);
            sendResponse({
              status: "success",
              message: "Settings updated processed"
            });
          });
        } else {
          sendResponse({
            status: "success",
            message: "Settings update ignored (tab not enabled or held)"
          });
        }
      });
      break;
    default:
      logError("Unknown message type", null, {
        tabId,
        message
      });
      sendResponse({
        status: "error",
        message: "Unknown message type"
      });
  }
  return true; // Allow async responses
});
// Popup connection handler
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  console.log("Popup đã kết nối");
  resetDebugLogCount(); // Reset debugLogCount khi popup kết nối
  const syncTabState = (tabId) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !isSupportedUrl(tab.url) || tab.status !== "complete") {
        updateIcon(tabId, false);
        return;
      }
      chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
        if (chrome.runtime.lastError) {
          logError("Lỗi khi lấy storage cho đồng bộ tab", chrome.runtime.lastError, {
            tabId
          });
          return;
        }
        const {
          activeTab,
          tabStates = {}
        } = result;
        if (activeTab !== tabId) {
          updateIcon(tabId, false);
          return;
        }
        sendMessageToTabDebounced(tabId, {
          type: "restore",
          ...(tabStates[tabId] || defaultSettings)
        }, () => {
          updateIcon(tabId, tabStates[tabId]?.enabled || false);
        });
      });
    });
  };
  const onActivatedListener = (activeInfo) => {
    resetDebugLogCount(); // Reset debugLogCount khi tab thay đổi
    syncTabState(activeInfo.tabId);
  };
  const onUpdatedListener = (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.active && isSupportedUrl(tab.url)) {
      resetDebugLogCount(); // Reset debugLogCount khi tab cập nhật
      syncTabState(tabId);
    }
  };
  chrome.tabs.onActivated.addListener(onActivatedListener);
  chrome.tabs.onUpdated.addListener(onUpdatedListener);
  port.onDisconnect.addListener(() => {
    console.log("Popup đã ngắt kết nối, xóa listeners");
    chrome.tabs.onActivated.removeListener(onActivatedListener);
    chrome.tabs.onUpdated.removeListener(onUpdatedListener);
  });
});
// Extension icon click handler
chrome.action.onClicked.addListener((tab) => {
  if (!isSupportedUrl(tab.url)) {
    console.log(`Skipping tab ${tab.id}: Not supported - URL: ${tab.url}`);
    updateIcon(tab.id, false);
    return;
  }
  chrome.storage.local.get(["activeTab", "tabStates", "isEnabled"], (result) => {
    if (chrome.runtime.lastError) {
      logError("Failed to get storage for icon click", chrome.runtime.lastError, {
        tabId: tab.id
      });
      return;
    }
    let {
      activeTab,
      tabStates = {},
      isEnabled = false
    } = result;
    const enabled = activeTab === tab.id && tabStates[tab.id]?.enabled;
    const newState = !enabled;
    if (newState) {
      tabStates[tab.id] = {
        ...defaultSettings,
        enabled: true,
        ...tabStates[tab.id]
      };
      isEnabled = true;
    } else {
      delete tabStates[tab.id];
      isEnabled = false;
      activeTab = null;
    }
    chrome.storage.local.set({
      activeTab: newState ? tab.id : null,
      tabStates,
      isEnabled
    }, () => {
      if (chrome.runtime.lastError) {
        logError("Failed to save state for icon click", chrome.runtime.lastError, {
          tabId: tab.id
        });
        return;
      }
      sendMessageToTabDebounced(tab.id, {
        enabled: newState
      }, (response) => {
        if (response?.status === "success") {
          updateIcon(tab.id, newState);
        }
      });
    });
  });
});
// Tab activation handler
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !isSupportedUrl(tab.url) || tab.status !== "complete") {
      updateIcon(activeInfo.tabId, false);
      return;
    }
    chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
      if (chrome.runtime.lastError) {
        logError("Failed to get storage for tab activation", chrome.runtime.lastError, {
          tabId: activeInfo.tabId
        });
        return;
      }
      let {
        activeTab,
        tabStates = {}
      } = result;
      if (activeTab !== activeInfo.tabId) {
        updateIcon(activeInfo.tabId, false);
        return;
      }
      sendMessageToTabDebounced(activeInfo.tabId, {
        type: "restore",
        ...(tabStates[activeInfo.tabId] || defaultSettings)
      }, () => {
        updateIcon(activeInfo.tabId, tabStates[activeInfo.tabId]?.enabled || false);
      });
    });
  });
});
// Tab update handler
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active || !isSupportedUrl(tab.url)) {
    if (changeInfo.status === "complete") updateIcon(tabId, false);
    return;
  }
  chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
    if (chrome.runtime.lastError) {
      logError("Lỗi khi lấy storage cho cập nhật tab", chrome.runtime.lastError, {
        tabId
      });
      return;
    }
    let {
      activeTab,
      tabStates = {}
    } = result;
    if (activeTab !== tabId) return;
    if (!tabStates[tabId]) {
      tabStates[tabId] = {
        ...defaultSettings,
        enabled: true
      };
    }
    chrome.storage.local.set({
      tabStates
    }, () => {
      if (chrome.runtime.lastError) {
        logError("Lỗi khi lưu trạng thái cho cập nhật tab", chrome.runtime.lastError, {
          tabId
        });
      }
      sendMessageToTabDebounced(tabId, {
        type: "apply_settings",
        ...tabStates[tabId]
      }, () => {
        updateIcon(tabId, tabStates[tabId].enabled);
        chrome.runtime.sendMessage({
          type: "videoChanged",
          videoSrc: tab.url.split(/[?#]/)[0],
          title: tab.title || "Unknown"
        }, () => {
          if (chrome.runtime.lastError && debugLogCount < maxDebugLogs) {
            console.debug(`Popup chưa mở, videoChanged không được chuyển tiếp (log ${debugLogCount + 1}/${maxDebugLogs})`);
            debugLogCount++;
          }
        });
      });
    });
  });
});
// Tab removal handler
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
    if (chrome.runtime.lastError) {
      logError("Failed to get storage for tab removal", chrome.runtime.lastError, {
        tabId
      });
      return;
    }
    let {
      activeTab,
      tabStates = {}
    } = result;
    if (activeTab === tabId) activeTab = null;
    delete tabStates[tabId];
    chrome.storage.local.set({
      activeTab,
      tabStates
    }, () => {
      if (chrome.runtime.lastError) {
        logError("Failed to clean up tab state", chrome.runtime.lastError, {
          tabId
        });
      }
    });
  });
});
// Extension installation/update handler
chrome.runtime.onInstalled.addListener((details) => {
  const manifest = chrome.runtime.getManifest();
  if (details.reason === "install") {
    console.log(`Pitch Shifter Pro v2 installed (v${manifest.version})`);
    chrome.storage.local.set({
      installed: true,
      version: manifest.version,
      isEnabled: false,
      activeTab: null,
      tabStates: {},
      favorites: [],
      installTimestamp: Date.now()
    }, () => {
      chrome.storage.sync.set({
        installTimestamp: Date.now()
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn("Error syncing installTimestamp to sync storage:", chrome.runtime.lastError);
        }
      });
    });
  } else if (details.reason === "update") {
    console.log(`Pitch Shifter Pro v2 updated to v${manifest.version}`);
    chrome.storage.local.set({
      version: manifest.version,
      lastVersion: manifest.version // ← Dòng quan trọng nhất
    });
  }
});
// Initialize service worker
console.log("Pitch Shifter Pro v2 background service worker started.");
chrome.tabs.query({
  active: true,
  currentWindow: true
}, (tabs) => {
  if (!tabs[0]) return;
  chrome.storage.local.get(["activeTab", "tabStates"], (result) => {
    if (chrome.runtime.lastError) {
      logError("Failed to get storage for initialization", chrome.runtime.lastError);
      return;
    }
    const enabled = result.activeTab === tabs[0].id && result.tabStates?.[tabs[0].id]?.enabled && isSupportedUrl(tabs[0].url);
    updateIcon(tabs[0].id, enabled);
  });
});

// =========================================================================
// PITCH SHIFTER DAIMON - BACKGROUND UPDATE SCRIPT (ANTI-SPAM & ANTI-CRASH)
// =========================================================================

const VERSION_CHECK_URL = "https://raw.githubusercontent.com/kcydvn-a11y/Pitch-Shifter-Pro/refs/heads/main/version.json";
const MIN_CHECK_INTERVAL = 21600000; // 6 tiếng

// So sánh semantic version đúng nghĩa
function isNewerVersion(currentStr, latestStr) {
  if (!currentStr || !latestStr) return false;
  const current = currentStr.split(".").map(Number);
  const latest  = latestStr.split(".").map(Number);
  const len = Math.max(current.length, latest.length);
  for (let i = 0; i < len; i++) {
    const a = current[i] || 0;
    const b = latest[i]  || 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
}

async function checkForUpdates() {
  const now = Date.now();
  const CURRENT_VERSION = chrome.runtime.getManifest().version;

  try {
    const storage = await chrome.storage.local.get(["lastCheckTime", "isSkippedUpdate"]);
    const lastCheckTime = storage.lastCheckTime || 0;
    const isSkippedUpdate = storage.isSkippedUpdate || "";

    // Chặn spam
    if (lastCheckTime > 0 && (now - lastCheckTime < MIN_CHECK_INTERVAL)) {
      console.log(`[Update] Còn ${Math.round((MIN_CHECK_INTERVAL - (now - lastCheckTime)) / 60000)} phút nữa mới check lại.`);
      return;
    }

    const response = await fetch(VERSION_CHECK_URL + "?t=" + now, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" }
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.warn("[Update] 429 – hoãn 1 tiếng");
        await chrome.storage.local.set({ lastCheckTime: now - MIN_CHECK_INTERVAL + 3600000 });
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    await chrome.storage.local.set({ lastCheckTime: now });

    console.log("[Update] Server trả về:", data);

    if (data.latest_version && isNewerVersion(CURRENT_VERSION, data.latest_version)) {
      // Nếu user đã skip bản này rồi thì ẩn
      if (data.latest_version === isSkippedUpdate) {
        console.log("[Update] Bản này đã skip trước đó → ẩn");
        await chrome.storage.local.remove(["updateInfo"]);
        return;
      }

      await chrome.storage.local.set({ updateInfo: data });
      console.log(`%c[Update] ✅ Có bản mới: ${data.latest_version} (hiện tại: ${CURRENT_VERSION})`, "color:lime;font-weight:bold");
    } else {
      // Bằng hoặc local cao hơn → xóa thông báo cũ
      await chrome.storage.local.remove(["updateInfo", "isSkippedUpdate"]);
      console.log(`[Update] Đang dùng bản mới nhất hoặc cao hơn (local: ${CURRENT_VERSION})`);
    }
  } catch (e) {
    console.error("[Update] Lỗi:", e.message || e);
  }
}

// ========== Lifecycle ==========
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.remove(["lastCheckTime", "updateInfo", "isSkippedUpdate"]);
  } else {
    // Update / reload → ép check ngay
    await chrome.storage.local.remove(["lastCheckTime"]);
  }

  chrome.alarms.create("checkUpdateAlarm", { periodInMinutes: 360 });
  checkForUpdates();
});

chrome.runtime.onStartup.addListener(checkForUpdates);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkUpdateAlarm") checkForUpdates();
});

// Lắng nghe từ popup (khi user bấm “Đã tải” hoặc “Bỏ qua”)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "clearUpdateBadge") {
    chrome.storage.local.set({ isSkippedUpdate: message.version }, () => {
      chrome.storage.local.remove(["updateInfo"], () => {
        console.log("[Update] Đã ghi nhận skip/tải xong");
        sendResponse({ status: "success" });
      });
    });
    return true; // giữ channel mở
  }
});