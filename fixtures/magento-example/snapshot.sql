-- Synthetic test data for the EXAMPLE Magento adapter (src/examples/magento/).
-- Hand-written in mysqldump's format, with made-up products. Not a real shop.
-- MySQL dump 10.13  Distrib 8.0.46, for Linux (x86_64)
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;

DROP TABLE IF EXISTS `store`;
CREATE TABLE `store` (
  `store_id` smallint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Store ID',
  `code` varchar(32) DEFAULT NULL COMMENT 'Code',
  `website_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Website ID',
  `group_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Group ID',
  `name` varchar(255) NOT NULL COMMENT 'Store Name',
  `sort_order` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store Sort Order',
  `is_active` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store Activity',
  PRIMARY KEY (`store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Stores';
LOCK TABLES `store` WRITE;
INSERT INTO `store` VALUES (0,'admin',0,0,'Admin',0,1),(1,'default',1,1,'Default Store View',0,1),(2,'german',1,1,'German',1,1);
UNLOCK TABLES;

DROP TABLE IF EXISTS `customer_entity`;
CREATE TABLE `customer_entity` (
  `entity_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Entity ID',
  `email` varchar(255) DEFAULT NULL COMMENT 'Email',
  PRIMARY KEY (`entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Customer Entity';
LOCK TABLES `customer_entity` WRITE;
INSERT INTO `customer_entity` VALUES (1,'not-read@example.com');
UNLOCK TABLES;

DROP TABLE IF EXISTS `core_config_data`;
CREATE TABLE `core_config_data` (
  `config_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Config ID',
  `scope` varchar(8) NOT NULL DEFAULT 'default' COMMENT 'Config Scope',
  `scope_id` int NOT NULL DEFAULT '0' COMMENT 'Config Scope ID',
  `path` varchar(255) NOT NULL DEFAULT 'general' COMMENT 'Config Path',
  `value` text COMMENT 'Config Value',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Updated At',
  PRIMARY KEY (`config_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Config Data';
LOCK TABLES `core_config_data` WRITE;
INSERT INTO `core_config_data` VALUES (1,'default',0,'currency/options/base','USD','2026-11-01 00:00:00');
UNLOCK TABLES;

DROP TABLE IF EXISTS `eav_entity_type`;
CREATE TABLE `eav_entity_type` (
  `entity_type_id` smallint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Entity Type ID',
  `entity_type_code` varchar(50) NOT NULL COMMENT 'Entity Type Code',
  PRIMARY KEY (`entity_type_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Eav Entity Type';
LOCK TABLES `eav_entity_type` WRITE;
INSERT INTO `eav_entity_type` VALUES (1,'customer'),(3,'catalog_category'),(4,'catalog_product');
UNLOCK TABLES;

DROP TABLE IF EXISTS `eav_attribute`;
CREATE TABLE `eav_attribute` (
  `attribute_id` smallint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Attribute ID',
  `entity_type_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Entity Type ID',
  `attribute_code` varchar(255) NOT NULL COMMENT 'Attribute Code',
  `backend_type` varchar(8) NOT NULL DEFAULT 'static' COMMENT 'Backend Type',
  `frontend_input` varchar(50) DEFAULT NULL COMMENT 'Frontend Input',
  `frontend_label` varchar(255) DEFAULT NULL COMMENT 'Frontend Label',
  `is_user_defined` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Defines Is User Defined',
  PRIMARY KEY (`attribute_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Eav Attribute';
LOCK TABLES `eav_attribute` WRITE;
INSERT INTO `eav_attribute` VALUES (45,3,'name','varchar','text','Name',0),(46,3,'is_active','int','select','Enable Category',0),(47,3,'description','text','textarea','Description',0),(70,3,'include_in_menu','int','select','Include in Navigation Menu',0),(119,3,'url_key','varchar','text','URL Key',0),(73,4,'name','varchar','text','Product Name',0),(75,4,'description','text','textarea','Description',0),(77,4,'price','decimal','price','Price',0),(78,4,'special_price','decimal','price','Special Price',0),(79,4,'special_from_date','datetime','date','Special Price From Date',0),(80,4,'special_to_date','datetime','date','Special Price To Date',0),(82,4,'weight','decimal','weight','Weight',0),(93,4,'color','int','select','Color',1),(97,4,'status','int','select','Enable Product',0),(99,4,'visibility','int','select','Visibility',0),(121,4,'url_key','varchar','text','URL Key',0),(132,4,'tax_class_id','int','select','Tax Class',0),(136,4,'material','varchar','multiselect','Material',1),(144,4,'size','int','select','Size',1),(150,4,'eco_collection','int','boolean','Eco Collection',1),(151,4,'care_note','varchar','text','Care note',1),(160,4,'msrp_display_actual_price_type','varchar','select','Display Actual Price',0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_eav_attribute`;
CREATE TABLE `catalog_eav_attribute` (
  `attribute_id` smallint unsigned NOT NULL COMMENT 'Attribute ID',
  `is_searchable` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Is Searchable',
  PRIMARY KEY (`attribute_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog EAV Attribute Table';
LOCK TABLES `catalog_eav_attribute` WRITE;
INSERT INTO `catalog_eav_attribute` VALUES (93,1),(136,1),(144,1),(150,0),(151,0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `eav_attribute_set`;
CREATE TABLE `eav_attribute_set` (
  `attribute_set_id` smallint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Attribute Set ID',
  `entity_type_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Entity Type ID',
  `attribute_set_name` varchar(255) DEFAULT NULL COMMENT 'Attribute Set Name',
  `sort_order` smallint NOT NULL DEFAULT '0' COMMENT 'Sort Order',
  PRIMARY KEY (`attribute_set_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Eav Attribute Set';
LOCK TABLES `eav_attribute_set` WRITE;
INSERT INTO `eav_attribute_set` VALUES (3,3,'Default',1),(4,4,'Default',1),(9,4,'Top',0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `eav_attribute_label`;
CREATE TABLE `eav_attribute_label` (
  `attribute_label_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Attribute Label ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `value` varchar(255) DEFAULT NULL COMMENT 'Value',
  PRIMARY KEY (`attribute_label_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Eav Attribute Label';
LOCK TABLES `eav_attribute_label` WRITE;
INSERT INTO `eav_attribute_label` (`attribute_label_id`, `attribute_id`, `store_id`, `value`) VALUES (1,93,2,'Farbe'),(2,144,2,'Größe');
UNLOCK TABLES;

DROP TABLE IF EXISTS `eav_attribute_option`;
CREATE TABLE `eav_attribute_option` (
  `option_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Option ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `sort_order` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Sort Order',
  PRIMARY KEY (`option_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Eav Attribute Option';
LOCK TABLES `eav_attribute_option` WRITE;
INSERT INTO `eav_attribute_option` VALUES (50,93,0),(51,93,1),(60,144,0),(61,144,1),(70,136,0),(71,136,1),(72,136,2),(80,160,0),(81,160,1);
UNLOCK TABLES;

DROP TABLE IF EXISTS `eav_attribute_option_value`;
CREATE TABLE `eav_attribute_option_value` (
  `value_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `option_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Option ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `value` varchar(255) DEFAULT NULL COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Eav Attribute Option Value';
LOCK TABLES `eav_attribute_option_value` WRITE;
INSERT INTO `eav_attribute_option_value` VALUES (1,50,0,'Blue'),(2,50,2,'Blau'),(3,51,0,'Red'),(4,51,2,'Rot'),(5,60,0,'S'),(6,61,0,'M'),(7,70,0,'Wool'),(8,71,0,'Wool'),(9,72,0,'Organic Cotton&trade;'),(10,80,0,'Use config'),(11,81,0,'On Gesture');
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_entity`;
CREATE TABLE `catalog_product_entity` (
  `entity_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Entity ID',
  `attribute_set_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute Set ID',
  `type_id` varchar(32) NOT NULL DEFAULT 'simple' COMMENT 'Type ID',
  `sku` varchar(64) NOT NULL COMMENT 'SKU',
  `has_options` smallint NOT NULL DEFAULT '0' COMMENT 'Has Options',
  `required_options` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Required Options',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation Time',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update Time',
  PRIMARY KEY (`entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Table';
LOCK TABLES `catalog_product_entity` WRITE;
INSERT INTO `catalog_product_entity` VALUES (1,9,'configurable','MT01',1,1,'2026-01-01 00:00:00','2026-01-01 00:00:00'),(2,9,'simple','MT01-S-Blue',0,0,'2026-01-01 00:00:00','2026-01-01 00:00:00'),(3,9,'simple','MT01-M-Red',0,0,'2026-01-01 00:00:00','2026-01-01 00:00:00'),(4,4,'simple','MB01',0,0,'2026-01-01 00:00:00','2026-01-01 00:00:00'),(5,4,'bundle','BUN1',0,0,'2026-01-01 00:00:00','2026-01-01 00:00:00'),(6,4,'simple','MB02 old',0,0,'2026-01-01 00:00:00','2026-01-01 00:00:00');
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_entity_varchar`;
CREATE TABLE `catalog_product_entity_varchar` (
  `value_id` int NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `value` varchar(255) DEFAULT NULL COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Varchar Attribute Backend Table';
LOCK TABLES `catalog_product_entity_varchar` WRITE;
INSERT INTO `catalog_product_entity_varchar` VALUES (1,73,0,1,'Trail Tee'),(2,73,2,1,'Wander-Shirt'),(3,121,0,1,'trail-tee'),(4,121,2,1,'wander-shirt'),(5,136,0,1,'70,72'),(6,73,0,2,'Trail Tee-S-Blue'),(7,73,0,3,'Trail Tee-M-Red'),(8,121,0,2,'trail-tee-s-blue'),(9,121,0,3,'trail-tee-m-red'),(10,73,0,4,'Summit Duffle&reg;'),(11,121,0,4,'summit-duffle'),(12,151,0,4,'Wipe clean &frac12; yearly'),(13,73,0,5,'Starter Kit'),(14,73,0,6,'Old Duffle'),(15,121,0,6,'old-duffle'),(16,160,0,1,'0'),(17,160,1,1,'1');
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_entity_int`;
CREATE TABLE `catalog_product_entity_int` (
  `value_id` int NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `value` int DEFAULT NULL COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Integer Attribute Backend Table';
LOCK TABLES `catalog_product_entity_int` WRITE;
INSERT INTO `catalog_product_entity_int` VALUES (1,97,0,1,1),(2,97,0,2,1),(3,97,0,3,1),(4,97,0,4,1),(5,97,0,5,1),(6,97,0,6,2),(7,99,0,1,4),(8,99,0,2,1),(9,99,0,3,1),(10,99,0,4,4),(11,132,0,1,2),(12,132,0,4,2),(13,93,0,2,50),(14,93,0,3,51),(15,144,0,2,60),(16,144,0,3,61),(17,150,0,4,1);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_entity_decimal`;
CREATE TABLE `catalog_product_entity_decimal` (
  `value_id` int NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `value` decimal(20,6) DEFAULT NULL COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Decimal Attribute Backend Table';
LOCK TABLES `catalog_product_entity_decimal` WRITE;
INSERT INTO `catalog_product_entity_decimal` VALUES (1,77,0,1,29.000000),(2,77,0,2,29.000000),(3,77,0,3,31.500000),(4,77,0,4,45.000000),(5,78,0,4,39.990000),(6,82,0,4,1.000000),(7,77,0,6,20.000000);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_entity_text`;
CREATE TABLE `catalog_product_entity_text` (
  `value_id` int NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `value` mediumtext COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Text Attribute Backend Table';
LOCK TABLES `catalog_product_entity_text` WRITE;
INSERT INTO `catalog_product_entity_text` VALUES (1,75,0,1,'<p>It\'s light, and it\'s \"quick-dry\".</p>\n<p>Machine wash &amp; tumble dry.</p>'),(2,75,0,4,'<p>A duffle for the trail.</p>');
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_entity_datetime`;
CREATE TABLE `catalog_product_entity_datetime` (
  `value_id` int NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `value` datetime DEFAULT NULL COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Datetime Attribute Backend Table';
LOCK TABLES `catalog_product_entity_datetime` WRITE;
INSERT INTO `catalog_product_entity_datetime` VALUES (1,79,0,4,'2026-11-01 00:00:00'),(2,80,0,4,'2026-11-30 00:00:00');
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_super_attribute`;
CREATE TABLE `catalog_product_super_attribute` (
  `product_super_attribute_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Product Super Attribute ID',
  `product_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Product ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `position` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Position',
  PRIMARY KEY (`product_super_attribute_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Super Attribute Table';
LOCK TABLES `catalog_product_super_attribute` WRITE;
INSERT INTO `catalog_product_super_attribute` VALUES (1,1,144,1),(2,1,93,0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_super_link`;
CREATE TABLE `catalog_product_super_link` (
  `link_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Link ID',
  `product_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Product ID',
  `parent_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Parent ID',
  PRIMARY KEY (`link_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Super Link Table';
LOCK TABLES `catalog_product_super_link` WRITE;
INSERT INTO `catalog_product_super_link` VALUES (1,2,1),(2,3,1);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_entity_media_gallery`;
CREATE TABLE `catalog_product_entity_media_gallery` (
  `value_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `value` varchar(255) DEFAULT NULL COMMENT 'Value',
  `media_type` varchar(32) NOT NULL DEFAULT 'image' COMMENT 'Media entry type',
  `disabled` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Visibility status',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Media Gallery Attribute Backend Table';
LOCK TABLES `catalog_product_entity_media_gallery` WRITE;
INSERT INTO `catalog_product_entity_media_gallery` VALUES (1,90,'/m/t/mt01-blue.jpg','image',0),(2,90,'/m/t/mt01-red.jpg','image',0),(3,90,'/m/b/mb01.jpg','image',0),(4,90,'/m/b/mb01-back.jpg','image',0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_product_entity_media_gallery_value`;
CREATE TABLE `catalog_product_entity_media_gallery_value` (
  `value_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Value ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `label` varchar(255) DEFAULT NULL COMMENT 'Label',
  `position` int unsigned DEFAULT NULL COMMENT 'Position',
  `disabled` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Is Disabled',
  `record_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Record ID',
  PRIMARY KEY (`record_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product Media Gallery Attribute Value Table';
LOCK TABLES `catalog_product_entity_media_gallery_value` WRITE;
INSERT INTO `catalog_product_entity_media_gallery_value` VALUES (1,0,2,NULL,1,0,1),(2,0,3,NULL,1,0,2),(4,0,4,'Back',2,0,3),(3,0,4,'Front',1,0,4);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_category_entity`;
CREATE TABLE `catalog_category_entity` (
  `entity_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Entity ID',
  `attribute_set_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute Set ID',
  `parent_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Parent Category ID',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation Time',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update Time',
  `path` varchar(255) NOT NULL COMMENT 'Tree Path',
  `position` int NOT NULL COMMENT 'Position',
  `level` int NOT NULL DEFAULT '0' COMMENT 'Tree Level',
  `children_count` int NOT NULL COMMENT 'Child Count',
  PRIMARY KEY (`entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Category Table';
LOCK TABLES `catalog_category_entity` WRITE;
INSERT INTO `catalog_category_entity` VALUES (1,3,0,'2026-01-01 00:00:00','2026-01-01 00:00:00','1',0,0,4),(2,3,1,'2026-01-01 00:00:00','2026-01-01 00:00:00','1/2',1,1,3),(3,3,2,'2026-01-01 00:00:00','2026-01-01 00:00:00','1/2/3',2,2,1),(4,3,3,'2026-01-01 00:00:00','2026-01-01 00:00:00','1/2/3/4',1,3,0),(5,3,2,'2026-01-01 00:00:00','2026-01-01 00:00:00','1/2/5',1,2,0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_category_entity_varchar`;
CREATE TABLE `catalog_category_entity_varchar` (
  `value_id` int NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `value` varchar(255) DEFAULT NULL COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Category Varchar Attribute Backend Table';
LOCK TABLES `catalog_category_entity_varchar` WRITE;
INSERT INTO `catalog_category_entity_varchar` VALUES (1,45,0,1,'Root Catalog'),(2,45,0,2,'Default Category'),(3,45,0,3,'Men'),(4,45,2,3,'Herren'),(5,119,0,3,'men'),(6,119,2,3,'herren'),(7,45,0,4,'Tops'),(8,119,0,4,'tops'),(9,45,0,5,'Gear &amp; Bags'),(10,119,0,5,'gear');
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_category_entity_int`;
CREATE TABLE `catalog_category_entity_int` (
  `value_id` int NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `value` int DEFAULT NULL COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Category Integer Attribute Backend Table';
LOCK TABLES `catalog_category_entity_int` WRITE;
INSERT INTO `catalog_category_entity_int` VALUES (1,46,0,3,1),(2,46,0,4,1),(3,46,0,5,1),(4,70,0,5,0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_category_entity_text`;
CREATE TABLE `catalog_category_entity_text` (
  `value_id` int NOT NULL AUTO_INCREMENT COMMENT 'Value ID',
  `attribute_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Attribute ID',
  `store_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Store ID',
  `entity_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Entity ID',
  `value` mediumtext COMMENT 'Value',
  PRIMARY KEY (`value_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Category Text Attribute Backend Table';
LOCK TABLES `catalog_category_entity_text` WRITE;
UNLOCK TABLES;

DROP TABLE IF EXISTS `catalog_category_product`;
CREATE TABLE `catalog_category_product` (
  `entity_id` int NOT NULL AUTO_INCREMENT COMMENT 'Entity ID',
  `category_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Category ID',
  `product_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Product ID',
  `position` int NOT NULL DEFAULT '0' COMMENT 'Position',
  PRIMARY KEY (`entity_id`,`category_id`,`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Catalog Product To Category Linkage Table';
LOCK TABLES `catalog_category_product` WRITE;
INSERT INTO `catalog_category_product` VALUES (1,4,1,1),(2,3,1,0),(3,5,4,2),(4,4,2,0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `cataloginventory_stock_item`;
CREATE TABLE `cataloginventory_stock_item` (
  `item_id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'Item ID',
  `product_id` int unsigned NOT NULL DEFAULT '0' COMMENT 'Product ID',
  `stock_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Stock ID',
  `qty` decimal(12,4) DEFAULT NULL COMMENT 'Qty',
  `is_in_stock` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Is In Stock',
  `manage_stock` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Manage Stock',
  `use_config_manage_stock` smallint unsigned NOT NULL DEFAULT '1' COMMENT 'Use Config Manage Stock',
  `website_id` smallint unsigned NOT NULL DEFAULT '0' COMMENT 'Website ID',
  PRIMARY KEY (`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Cataloginventory Stock Item';
LOCK TABLES `cataloginventory_stock_item` WRITE;
INSERT INTO `cataloginventory_stock_item` VALUES (1,1,1,0.0000,1,1,1,0),(2,2,1,10.0000,1,1,1,0),(3,3,1,5.0000,1,1,1,0),(4,4,1,100.0000,1,1,1,0),(5,5,1,0.0000,1,1,1,0),(6,6,1,3.0000,1,1,1,0);
UNLOCK TABLES;

DROP TABLE IF EXISTS `tax_class`;
CREATE TABLE `tax_class` (
  `class_id` smallint NOT NULL AUTO_INCREMENT COMMENT 'Class ID',
  `class_name` varchar(255) NOT NULL COMMENT 'Class Name',
  `class_type` varchar(8) NOT NULL DEFAULT 'CUSTOMER' COMMENT 'Class Type',
  PRIMARY KEY (`class_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COMMENT='Tax Class';
LOCK TABLES `tax_class` WRITE;
INSERT INTO `tax_class` VALUES (2,'Taxable Goods','PRODUCT'),(3,'Retail Customer','CUSTOMER');
UNLOCK TABLES;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
-- Dump completed on 2026-11-18  8:00:00
