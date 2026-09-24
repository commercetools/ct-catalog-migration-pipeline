# Sample payloads

One product per variant-count shape, as it will be sent. Check the money values against the source before loading: minor-unit conversion is the defect that looks most like success.

## `mig-CAP-LOGO` — 1 variant(s)

```json
{
  "key": "mig-CAP-LOGO",
  "productType": {
    "typeId": "product-type",
    "key": "mig-apparel-basic"
  },
  "name": {
    "en-GB": "Logo Cap",
    "de-DE": "Logo-Kappe"
  },
  "slug": {
    "en-GB": "logo-cap",
    "de-DE": "logo-kappe"
  },
  "categories": [
    {
      "typeId": "category",
      "key": "mig-accessories"
    }
  ],
  "masterVariant": {
    "key": "mig-CAP-LOGO-OS",
    "sku": "CAP-LOGO-OS",
    "attributes": [
      {
        "type": "ltext",
        "name": "material",
        "value": {
          "en-GB": "Cotton twill",
          "de-DE": "Baumwoll-Twill"
        }
      },
      {
        "type": "boolean",
        "name": "organicCertified",
        "value": false
      },
      {
        "type": "number",
        "name": "weightGrams",
        "value": 95
      }
    ],
    "images": [],
    "prices": [
      {
        "key": "mig-CAP-LOGO-OS-GBP-GB",
        "value": {
          "type": "centPrecision",
          "currencyCode": "GBP",
          "centAmount": 2400,
          "fractionDigits": 2
        },
        "country": "GB"
      },
      {
        "key": "mig-CAP-LOGO-OS-EUR-DE",
        "value": {
          "type": "centPrecision",
          "currencyCode": "EUR",
          "centAmount": 2800,
          "fractionDigits": 2
        },
        "country": "DE"
      }
    ]
  },
  "variants": [],
  "priceMode": "Embedded",
  "publish": false
}
```

Prices decoded back from minor units:

| SKU | Currency | Minor units | Decimal | Scope |
| :--- | :--- | ---: | ---: | :--- |
| `CAP-LOGO-OS` | GBP | 2400 | 24.00 | country=GB |
| `CAP-LOGO-OS` | EUR | 2800 | 28.00 | country=DE |

## `mig-JKT-FIELD` — 2 variant(s)

```json
{
  "key": "mig-JKT-FIELD",
  "productType": {
    "typeId": "product-type",
    "key": "mig-apparel-basic"
  },
  "name": {
    "en-GB": "Field Jacket",
    "de-DE": "Feldjacke"
  },
  "slug": {
    "en-GB": "field-jacket",
    "de-DE": "feldjacke"
  },
  "description": {
    "en-GB": "Waxed cotton, four pockets.",
    "de-DE": "Gewachste Baumwolle, vier Taschen."
  },
  "categories": [
    {
      "typeId": "category",
      "key": "mig-outerwear"
    }
  ],
  "masterVariant": {
    "key": "mig-JKT-FIELD-OAT-L",
    "sku": "JKT-FIELD-OAT-L",
    "attributes": [
      {
        "type": "lenum",
        "name": "colour",
        "value": "OAT"
      },
      {
        "type": "ltext",
        "name": "material",
        "value": {
          "en-GB": "Waxed cotton",
          "de-DE": "Gewachste Baumwolle"
        }
      },
      {
        "type": "boolean",
        "name": "organicCertified",
        "value": false
      },
      {
        "type": "enum",
        "name": "size",
        "value": "L"
      },
      {
        "type": "number",
        "name": "weightGrams",
        "value": 880
      }
    ],
    "images": [],
    "prices": [
      {
        "key": "mig-JKT-FIELD-OAT-L-GBP-GB",
        "value": {
          "type": "centPrecision",
          "currencyCode": "GBP",
          "centAmount": 14900,
          "fractionDigits": 2
        },
        "country": "GB"
      },
      {
        "key": "mig-JKT-FIELD-OAT-L-EUR-DE",
        "value": {
          "type": "centPrecision",
          "currencyCode": "EUR",
          "centAmount": 17500,
          "fractionDigits": 2
        },
        "country": "DE"
      }
    ]
  },
  "variants": [
    {
      "key": "mig-JKT-FIELD-OAT-M",
      "sku": "JKT-FIELD-OAT-M",
      "attributes": [
        {
          "type": "lenum",
          "name": "colour",
          "value": "OAT"
        },
        {
          "type": "ltext",
          "name": "material",
          "value": {
            "en-GB": "Waxed cotton",
            "de-DE": "Gewachste Baumwolle"
          }
        },
        {
          "type": "boolean",
          "name": "organicCertified",
          "value": false
        },
        {
          "type": "enum",
          "name": "size",
          "value": "M"
        },
        {
          "type": "number",
          "name": "weightGrams",
          "value": 840
        }
      ],
      "images": [],
      "prices": [
        {
          "key": "mig-JKT-FIELD-OAT-M-GBP-GB",
          "value": {
            "type": "centPrecision",
            "currencyCode": "GBP",
            "centAmount": 14900,
            "fractionDigits": 2
          },
          "country": "GB"
        },
        {
          "key": "mig-JKT-FIELD-OAT-M-EUR-DE",
          "value": {
            "type": "centPrecision",
            "currencyCode": "EUR",
            "centAmount": 17500,
            "fractionDigits": 2
          },
          "country": "DE"
        },
        {
          "key": "mig-JKT-FIELD-OAT-M-GBP-GB-20261127-20261202",
          "value": {
            "type": "centPrecision",
            "currencyCode": "GBP",
            "centAmount": 11900,
            "fractionDigits": 2
          },
          "country": "GB",
          "validFrom": "2026-11-27T00:00:00.000Z",
          "validUntil": "2026-12-02T00:00:00.000Z"
        }
      ]
    }
  ],
  "priceMode": "Embedded",
  "publish": false
}
```

Prices decoded back from minor units:

| SKU | Currency | Minor units | Decimal | Scope |
| :--- | :--- | ---: | ---: | :--- |
| `JKT-FIELD-OAT-L` | GBP | 14900 | 149.00 | country=GB |
| `JKT-FIELD-OAT-L` | EUR | 17500 | 175.00 | country=DE |
| `JKT-FIELD-OAT-M` | GBP | 14900 | 149.00 | country=GB |
| `JKT-FIELD-OAT-M` | EUR | 17500 | 175.00 | country=DE |
| `JKT-FIELD-OAT-M` | GBP | 11900 | 119.00 | country=GB, valid 2026-11-27T00:00:00.000Z..2026-12-02T00:00:00.000Z |

## `mig-TEE-CLASSIC` — 4 variant(s)

```json
{
  "key": "mig-TEE-CLASSIC",
  "productType": {
    "typeId": "product-type",
    "key": "mig-apparel-basic"
  },
  "name": {
    "en-GB": "Classic T-Shirt",
    "de-DE": "Klassisches T-Shirt"
  },
  "slug": {
    "en-GB": "classic-t-shirt",
    "de-DE": "klassisches-t-shirt"
  },
  "description": {
    "en-GB": "A midweight cotton tee.",
    "de-DE": "Ein T-Shirt aus mittelschwerer Baumwolle."
  },
  "categories": [
    {
      "typeId": "category",
      "key": "mig-tops"
    }
  ],
  "masterVariant": {
    "key": "mig-TEE-CLASSIC-BLK-S",
    "sku": "TEE-CLASSIC-BLK-S",
    "attributes": [
      {
        "type": "lenum",
        "name": "colour",
        "value": "BLK"
      },
      {
        "type": "ltext",
        "name": "material",
        "value": {
          "en-GB": "100% organic cotton",
          "de-DE": "100% Bio-Baumwolle"
        }
      },
      {
        "type": "boolean",
        "name": "organicCertified",
        "value": true
      },
      {
        "type": "enum",
        "name": "size",
        "value": "S"
      },
      {
        "type": "number",
        "name": "weightGrams",
        "value": 180
      }
    ],
    "images": [
      {
        "url": "https://cdn.example.com/tee-blk.jpg",
        "dimensions": {
          "w": 1200,
          "h": 1600
        }
      }
    ],
    "prices": [
      {
        "key": "mig-TEE-CLASSIC-BLK-S-GBP-GB",
        "value": {
          "type": "centPrecision",
          "currencyCode": "GBP",
          "centAmount": 1999,
          "fractionDigits": 2
        },
        "country": "GB"
      },
      {
        "key": "mig-TEE-CLASSIC-BLK-S-EUR-DE",
        "value": {
          "type": "centPrecision",
          "currencyCode": "EUR",
          "centAmount": 2350,
          "fractionDigits": 2
        },
        "country": "DE"
      }
    ]
  },
  "variants": [
    {
      "key": "mig-TEE-CLASSIC-BLK-M",
      "sku": "TEE-CLASSIC-BLK-M",
      "attributes": [
        {
          "type": "lenum",
          "name": "colour",
          "value": "BLK"
        },
        {
          "type": "ltext",
          "name": "material",
          "value": {
            "en-GB": "100% organic cotton",
            "de-DE": "100% Bio-Baumwolle"
          }
        },
        {
          "type": "boolean",
          "name": "organicCertified",
          "value": true
        },
        {
          "type": "enum",
          "name": "size",
          "value": "M"
        },
        {
          "type": "number",
          "name": "weightGrams",
          "value": 190
        }
      ],
      "images": [
        {
          "url": "https://cdn.example.com/tee-blk.jpg",
          "dimensions": {
            "w": 1200,
            "h": 1600
          }
        }
      ],
      "prices": [
        {
          "key": "mig-TEE-CLASSIC-BLK-M-GBP-GB",
          "value": {
            "type": "centPrecision",
            "currencyCode": "GBP",
            "centAmount": 1999,
            "fractionDigits": 2
          },
          "country": "GB"
        },
        {
          "key": "mig-TEE-CLASSIC-BLK-M-EUR-DE",
          "value": {
            "type": "centPrecision",
            "currencyCode": "EUR",
            "centAmount": 2350,
            "fractionDigits": 2
          },
          "country": "DE"
        }
      ]
    },
    {
      "key": "mig-TEE-CLASSIC-NVY-L",
      "sku": "TEE-CLASSIC-NVY-L",
      "attributes": [
        {
          "type": "lenum",
          "name": "colour",
          "value": "NVY"
        },
        {
          "type": "ltext",
          "name": "material",
          "value": {
            "en-GB": "100% organic cotton",
            "de-DE": "100% Bio-Baumwolle"
          }
        },
        {
          "type": "boolean",
          "name": "organicCertified",
          "value": true
        },
        {
          "type": "enum",
          "name": "size",
          "value": "L"
        },
        {
          "type": "number",
          "name": "weightGrams",
          "value": 205
        }
      ],
      "images": [],
      "prices": [
        {
          "key": "mig-TEE-CLASSIC-NVY-L-GBP-GB",
          "value": {
            "type": "centPrecision",
            "currencyCode": "GBP",
            "centAmount": 1999,
            "fractionDigits": 2
          },
          "country": "GB"
        },
        {
          "key": "mig-TEE-CLASSIC-NVY-L-EUR-DE",
          "value": {
            "type": "centPrecision",
            "currencyCode": "EUR",
            "centAmount": 2350,
            "fractionDigits": 2
          },
          "country": "DE"
        }
      ]
    },
    {
      "key": "mig-TEE-CLASSIC-NVY-M",
      "sku": "TEE-CLASSIC-NVY-M",
      "attributes": [
        {
          "type": "lenum",
          "name": "colour",
          "value": "NVY"
        },
        {
          "type": "ltext",
          "name": "material",
          "value": {
            "en-GB": "100% organic cotton",
            "de-DE": "100% Bio-Baumwolle"
          }
        },
        {
          "type": "boolean",
          "name": "organicCertified",
          "value": true
        },
        {
          "type": "enum",
          "name": "size",
          "value": "M"
        },
        {
          "type": "number",
          "name": "weightGrams",
          "value": 190
        }
      ],
      "images": [
        {
          "url": "https://cdn.example.com/tee-nvy.jpg",
          "dimensions": {
            "w": 1200,
            "h": 1600
          }
        }
      ],
      "prices": [
        {
          "key": "mig-TEE-CLASSIC-NVY-M-GBP-GB",
          "value": {
            "type": "centPrecision",
            "currencyCode": "GBP",
            "centAmount": 1999,
            "fractionDigits": 2
          },
          "country": "GB"
        },
        {
          "key": "mig-TEE-CLASSIC-NVY-M-EUR-DE",
          "value": {
            "type": "centPrecision",
            "currencyCode": "EUR",
            "centAmount": 2350,
            "fractionDigits": 2
          },
          "country": "DE"
        }
      ]
    }
  ],
  "priceMode": "Embedded",
  "publish": false
}
```

Prices decoded back from minor units:

| SKU | Currency | Minor units | Decimal | Scope |
| :--- | :--- | ---: | ---: | :--- |
| `TEE-CLASSIC-BLK-S` | GBP | 1999 | 19.99 | country=GB |
| `TEE-CLASSIC-BLK-S` | EUR | 2350 | 23.50 | country=DE |
| `TEE-CLASSIC-BLK-M` | GBP | 1999 | 19.99 | country=GB |
| `TEE-CLASSIC-BLK-M` | EUR | 2350 | 23.50 | country=DE |
| `TEE-CLASSIC-NVY-L` | GBP | 1999 | 19.99 | country=GB |
| `TEE-CLASSIC-NVY-L` | EUR | 2350 | 23.50 | country=DE |
| `TEE-CLASSIC-NVY-M` | GBP | 1999 | 19.99 | country=GB |
| `TEE-CLASSIC-NVY-M` | EUR | 2350 | 23.50 | country=DE |
