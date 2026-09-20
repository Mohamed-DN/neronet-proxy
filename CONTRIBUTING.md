# Contributing to NeroNet

First off, thank you for considering contributing to NeroNet! It's people like you that make NeroNet such a great tool for privacy and decentralized networking.

## Code of Conduct
By participating in this project, you agree to abide by our Code of Conduct. We expect all contributors to maintain a respectful and inclusive environment.

## How Can I Contribute?

### 1. Reporting Bugs
If you find a bug, please open an issue on GitHub. Before creating a new issue, check if it has already been reported. Include:
- A quick summary and/or background
- Steps to reproduce
- What you expected would happen
- What actually happens
- Notes (possibly including why you think this might be happening)

### 2. Suggesting Enhancements
Enhancement suggestions are tracked as GitHub issues. When creating an enhancement issue, please provide a clear and detailed explanation of the feature you want, why it is needed, and how it should work.

### 3. Pull Requests (Code Contributions)
The best way to contribute code is to fork the repository, make your changes, and submit a Pull Request (PR).

**Development Workflow:**
1. Fork the repo and create your branch from `main`.
2. Name your branch logically (e.g., `feat/add-wireguard-fallback` or `fix/memory-leak-router`).
3. Make sure you have read `DEVELOPER_SETUP.md` and successfully run the project locally.
4. If you've added code that should be tested, add tests!
5. Ensure the test suites pass: `sh scripts/dev/test-go.sh`, `sh scripts/dev/test-backend.sh` and `sh scripts/dev/test-frontend.sh`.
6. Format your code (e.g., `go fmt`).
7. Submit the PR with a comprehensive description of the changes.

### 4. Contributing to Documentation
Documentation is just as important as code! You can help by:
- Fixing typos
- Writing tutorials
- Improving the `README.md` or `DEVELOPER_SETUP.md`
- Translating documents

## Development Guidelines
- **Languages:** Go (1.25 or later) for the nodes, Node.js 22 for the control plane, React for the console.
- **Architecture:** Read `docs/HANDBOOK.md` and the decision records in `docs/adr/` first. A change that departs from a decision needs a new record.
- **Security First:** Any PR modifying cryptographic code, the node protocol, or user authentication will require a strict review process and potentially an external audit before merge.
- **Auto-Scaling & Cloud:** If modifying `docs/AUTOSCALING.md` or Helm charts, ensure backwards compatibility with local bare-metal deployments.

## Licensing
By contributing to NeroNet, you agree that your contributions will be licensed under its **AGPL-3.0 License**.

Thank you for helping us build a secure, censorship-resistant future!
