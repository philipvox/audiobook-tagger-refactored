.PHONY: dev build clean install-deps

dev:
	pnpm tauri dev

build:
	pnpm tauri build

clean:
	rm -rf src-tauri/target dist node_modules

install-deps:
	pnpm install
	cd src-tauri && cargo fetch

test:
	cd src-tauri && cargo test
