export const THEME_STORAGE_KEY = "lido-watch-theme";

// Runs in the document head, before cards paint or React hydrates.
export const THEME_INIT_SCRIPT = `(()=>{let t;try{t=localStorage.getItem("${THEME_STORAGE_KEY}")}catch{}document.documentElement.dataset.theme=t==="dark"||t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"})()`;
