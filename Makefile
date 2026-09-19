.PHONY: all build test clean run-control run-relay run-node lint

BIN_DIR := bin

all: build test

build:
	@mkdir -p $(BIN_DIR)
	@echo "Building sovereign-control-plane..."
	@go build -o $(BIN_DIR)/sovereign-control-plane ./cmd/sovereign-control-plane
	@echo "Building sovereign-derp-relay..."
	@go build -o $(BIN_DIR)/sovereign-derp-relay ./cmd/sovereign-derp-relay
	@echo "Building sovereign-node..."
	@go build -o $(BIN_DIR)/sovereign-node ./cmd/sovereign-node
	@echo "Building sovereign-cli..."
	@go build -o $(BIN_DIR)/sovereign-cli ./cmd/sovereign-cli
	@echo "All binaries successfully built in $(BIN_DIR)/"

test:
	@echo "Running all unit and integration test suites..."
	@go test -v -race ./pkg/...

lint:
	@echo "Running go vet on all packages..."
	@go vet ./...

clean:
	@rm -rf $(BIN_DIR)
	@echo "Cleaned build artifacts."
