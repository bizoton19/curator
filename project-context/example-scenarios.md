# Example Scenarios

This file contains example workspace content for the Curator training module. Each section below provides realistic sample content that demonstrates how to use the cost estimation workflow.

---

## Scenario: AI-Powered Product Sample Labeling System

### Client Overview
A manufacturing client wants to modernize their quality control process by implementing an AI/ML solution that automatically labels product samples. The system will ingest images from multiple sources: handheld scanners, Meta smart glasses worn by floor inspectors, and live iPhone camera feeds from mobile QC stations.

---

## BASELINE EXAMPLE

```markdown
# Baseline

## Project Overview
Enterprise AI/ML solution for automated product sample labeling and classification. The system will process images from three input channels (industrial scanners, Meta smart glasses, iPhone cameras) and apply trained ML models to automatically categorize and label product samples in real-time.

## Scope

### In Scope
- Azure cloud infrastructure design and deployment
- ML model development for product classification (transfer learning approach)
- Integration with existing scanner hardware via REST APIs
- Meta Quest/smart glasses companion app for hands-free capture
- iOS mobile app for iPhone camera integration
- Real-time inference pipeline using Azure ML
- Integration with Microsoft Fabric for data lakehouse storage
- PySpark ETL pipelines for training data preparation
- Dashboard for QC managers (Power BI embedded)
- 5-year total cost of ownership model

### Out of Scope
- Hardware procurement (scanners, glasses, phones)
- On-premise server infrastructure
- ERP integration (phase 2)
- Multi-language label support (English only for v1)

## Assumptions
- Client has existing Azure subscription with Foundry access
- Network connectivity at all capture stations (WiFi 6 minimum)
- Product catalog with 500-2000 SKU categories for initial training
- Client will provide 10,000+ labeled sample images for model training
- Privacy requirements allow cloud processing (no on-premise mandate)
- DC labor rates apply (Washington DC metro area contractors)
- 5-year planning horizon for cost estimates
- Client IT team available for knowledge transfer

## Constraints
- Budget approval required before Phase 2
- Go-live target: Q3 2026
- Must comply with client's existing Azure governance policies
- Model accuracy target: 95%+ on known SKUs
```

---

## REQUIREMENTS EXAMPLE

```markdown
# Requirements

## Goals
- Reduce manual labeling time by 80% within 6 months of deployment
- Achieve 95%+ classification accuracy on trained product categories
- Support real-time inference (<2 second response time per image)
- Enable hands-free operation for floor inspectors via smart glasses

## Constraints
- Timeline: 9-month delivery schedule (3 phases)
- Budget: Initial estimate range $800K-$1.2M over 5 years
- Team: Blended team (client + contractor) with DC labor rates
- Technology: Must use Azure services (Foundry, Fabric, Azure ML)

## Acceptance Criteria
- ML model passes UAT with 95%+ accuracy on test dataset
- All three input channels (scanner, glasses, iPhone) functional
- Real-time dashboard shows labeling metrics and confidence scores
- Cost estimate is auditable with line-item breakdown
- 5-year TCO model approved by client finance

## Pricing Inputs
- Labor: DC metro rates ($150-250/hr depending on role)
- Azure consumption: Estimated $15-25K/month at steady state
- ML training compute: One-time $10-20K for initial model development
- Licensing: Microsoft Fabric, Power BI Pro seats
- Support: 20% annual maintenance after go-live
```

---

## TASKS EXAMPLE

```markdown
# Tasks

## PLAN
- Review baseline.md to confirm scope boundaries and assumptions
- Review requirements.md to understand success criteria and constraints
- Analyze context documents in context-documents/ for technical specifications
- Identify any gaps in provided information that need client clarification

## EXECUTE
- Create work breakdown structure with 3 phases (Foundation, Core ML, Integration)
- Estimate labor hours by role (Architect, ML Engineer, Mobile Dev, DevOps)
- Apply DC labor rates to hour estimates
- Calculate Azure infrastructure costs using Azure pricing calculator assumptions
- Build 5-year cost projection including maintenance and scaling
- Generate cost-estimate.md with summary table and detailed breakdown

## REVIEW
- Validate estimates against similar projects in templates/
- Summarize key cost drivers and risk factors
- Highlight assumptions that most impact the estimate
- Flag any scope items that need clarification before finalizing

## REFINE
- Update estimates based on review feedback
- Add contingency recommendations (typically 15-25% for ML projects)
- Prepare executive summary for client presentation
```

---

## CONTEXT DOCUMENTS EXAMPLE

### azure-architecture.md
```markdown
# Azure Architecture Overview

## Compute
- Azure Machine Learning workspace for model training and deployment
- Azure Kubernetes Service (AKS) for inference endpoints
- Azure Functions for event-driven image processing

## Storage
- Microsoft Fabric Lakehouse for raw and processed images
- Azure Blob Storage for model artifacts
- Azure SQL for metadata and labeling results

## Integration
- Azure Event Grid for real-time event routing
- Azure API Management for external API exposure
- Azure IoT Hub for scanner device management
```

### labor-rates.md
```markdown
# DC Metro Labor Rate Card

| Role | Hourly Rate | Notes |
|------|-------------|-------|
| Solution Architect | $225/hr | Azure certified |
| ML Engineer | $200/hr | Python, PySpark, Azure ML |
| Mobile Developer | $175/hr | iOS + React Native |
| DevOps Engineer | $185/hr | Azure DevOps, Terraform |
| QA Engineer | $150/hr | Test automation |
| Project Manager | $165/hr | Agile/Scrum |
| Business Analyst | $155/hr | Requirements, UAT |
```

### privacy-requirements.md
```markdown
# Privacy & Compliance Requirements

## Data Handling
- All product images processed in Azure US regions only
- No PII in product images (manufacturing floor only)
- Retention policy: Raw images 90 days, labeled results 7 years

## Access Control
- Azure AD integration for all users
- Role-based access control (RBAC) for data tiers
- Audit logging for all model inference calls

## Compliance
- SOC 2 Type II compliance required
- Annual security assessment by client InfoSec
```

---

## Training Module Instructions

When a user invokes the training module, the system should:

1. **Create a "training" workspace** with pre-populated files from the examples above
2. **Walk through each step** with read-only content and explanatory overlays
3. **Highlight key sections** as the user progresses through Baseline → Context → Requirements → Tasks
4. **Allow restart** so users can replay the training anytime
5. **Exit cleanly** back to their real workspace when complete
