.PHONY: all build test clean run-relay run-node lint contractgen

BIN_DIR := bin

all: build test

build:
	@mkdir -p $(BIN_DIR)
	@echo "Building sovereign-derp-relay..."
	@go build -o $(BIN_DIR)/sovereign-derp-relay ./cmd/sovereign-derp-relay
	@echo "Building sovereign-node..."
	@go build -o $(BIN_DIR)/sovereign-node ./cmd/sovereign-node
	@echo "Building sovereign-cli..."
	@go build -o $(BIN_DIR)/sovereign-cli ./cmd/sovereign-cli
	@echo "All binaries successfully built in $(BIN_DIR)/"

contractgen:
	@echo "Generating JSON Schemas from Go struct tags..."
	@go run ./cmd/contractgen

test:
	@echo "Running all unit and integration test suites..."
	@go test -v -race ./pkg/...

lint:
	@echo "Running go vet on all packages..."
	@go vet ./...

clean:
	@rm -rf $(BIN_DIR)
	@echo "Cleaned build artifacts."

build-windows:
	@mkdir -p bin
	@echo "Building neronet-windows.exe..."
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/neronet-windows.exe ./cmd/neronet-windows
